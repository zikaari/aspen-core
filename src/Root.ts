import { Disposable, DisposablesComposite, IDisposable, Notificar } from 'notificar'
import pSeries = require('p-series')
import { PathFx, unix, win32 } from 'path-fx'
import { Directory } from './Directory'
import { FileEntry } from './FileEntry'
import { FileOrDir, FileTreeEvent, FileType, IBasicFileSystemHost, IMetadataChange, ITreeSupervisor, IWatcherEvent, TopDownIteratorCallback, WatcherCallback, WatchEvent, WatchTerminator } from './types'

interface IWatcherInfo {
	terminator: WatchTerminator
	callback: WatcherCallback
}

export class Root extends Directory {
	public readonly host: IBasicFileSystemHost
	private readonly _pathfx: PathFx
	private rootPath: string
	private events: Notificar<FileTreeEvent>
	private onceItemVisibleWatchers: WeakMap<FileOrDir, { item: FileOrDir, disposer: DisposablesComposite, callbacks: Set<(item: FileOrDir) => void> }>
	private onceDirectoryExpandedWatchers: WeakMap<Directory, Set<(directory: Directory, nowExpanded: boolean, visibleAtSurface: boolean) => void>>
	private onceDisposedWatchers: WeakMap<FileOrDir, Set<(target: FileOrDir) => void>>
	private onceParentChangedWatchers: WeakMap<FileOrDir, Set<(target: FileOrDir, prevParent: Directory, newParent: Directory) => void>>

	private fswatchers: Map<string, IWatcherInfo>
	/**
	 * When a big chain of generic "change" events come our way, we batch them up in a queue and dispatch them "efficently" after 't' milliseconds.
	 *
	 * This is usually in case of chokidar watcher when usePolling is enabled (https://www.npmjs.com/package/chokidar#performance)
	 *
	 * ONLY GENERIC CHANGE EVENTS GET QUEUED, OTHER SPECIFIC EVENTS ARE DISPATCHED AS THEY COME
	 */
	private changeEventDispatchQueue: string[]
	/**
	 * Timeout after which all queued change events will be auto fired and list will be flushed for next use
	 */
	private eventFlushTimeout: number

	constructor(host: IBasicFileSystemHost, root: string) {
		const pathfx = host.pathStyle === 'win32' ? win32 : unix
		if (pathfx.isRelative(root)) {
			throw new Error(`Root path must be absolute. Example: 'C:\\Users\\Desktop' or '/home/desktop'`)
		}

		const superv: ITreeSupervisor = {
			notifyWillProcessWatchEvent: (t: Directory, event: IWatcherEvent) => {
				this.events.dispatch(FileTreeEvent.WillProcessWatchEvent, t, event)
			},
			notifyDidProcessWatchEvent: (t: Directory, event: IWatcherEvent) => {
				this.events.dispatch(FileTreeEvent.DidProcessWatchEvent, t, event)
			},
			notifyDidChangeMetadata: (t: FileEntry | Directory, change: IMetadataChange) => {
				this.events.dispatch(FileTreeEvent.DidChangeMetadata, t, change)
			},
			notifyDidChangePath: (t: FileOrDir) => {
				this.events.dispatch(FileTreeEvent.DidChangePath, t)
			},
			notifyWillChangeParent: (t: FileOrDir, prevParent: Directory, newParent: Directory) => {
				this.events.dispatch(FileTreeEvent.WillChangeParent, t, prevParent, newParent)
			},
			notifyDidChangeParent: (t: FileOrDir, prevParent: Directory, newParent: Directory) => {
				if (this.onceParentChangedWatchers.has(t)) {
					const callbacks = this.onceParentChangedWatchers.get(t)
					for (const cb of callbacks) { cb(t, prevParent, newParent) }
					this.onceParentChangedWatchers.delete(t)
				}
				this.events.dispatch(FileTreeEvent.DidChangeParent, t, prevParent, newParent)
			},
			notifyWillDispose: (t: FileOrDir) => {
				this.events.dispatch(FileTreeEvent.WillDispose, t)
			},
			notifyDidDispose: (t: FileOrDir) => {
				if (this.onceDisposedWatchers.has(t)) {
					const callbacks = this.onceDisposedWatchers.get(t)
					for (const cb of callbacks) { cb(t) }
					this.onceDisposedWatchers.delete(t)
				}
				this.events.dispatch(FileTreeEvent.DidDispose, t)
			},
			notifyWillChangeExpansionState: (t: Directory, nowExpanded: boolean) => {
				this.events.dispatch(FileTreeEvent.WillChangeExpansionState, t, nowExpanded)
			},
			notifyDidChangeExpansionState: (t: Directory, nowExpanded: boolean) => {
				const isVisibleAtSurface = this.isItemVisibleAtSurface(t)
				if (t.expanded) {
					if (this.onceItemVisibleWatchers.has(t) && isVisibleAtSurface) {
						const { callbacks, disposer, item } = this.onceItemVisibleWatchers.get(t)
						for (const cb of callbacks) { cb(item) }
						disposer.dispose()
					}
					if (this.onceDirectoryExpandedWatchers.has(t)) {
						const callbacks = this.onceDirectoryExpandedWatchers.get(t)
						for (const cb of callbacks) { cb(t, nowExpanded, isVisibleAtSurface) }
						this.onceDirectoryExpandedWatchers.delete(t)
					}
				}
				this.events.dispatch(FileTreeEvent.DidChangeExpansionState, t, nowExpanded, isVisibleAtSurface)
			},
			supervisedWatch: (path: string, callback: WatcherCallback): WatchTerminator => {
				path = pathfx.normalize(path)
				// Might be overwritten if host.watch is available
				let terminator: WatchTerminator = this.terminateWatch
				if (host && typeof host.watch === 'function') {
					terminator = host.watch(path)
				}

				this.fswatchers.set(path, { terminator, callback })
				return terminator
			},
		}
		// Root has no "parent" and no applicable "dirname" or "filename"
		super(null, superv, null, null)
		this._pathfx = pathfx
		this.host = host
		this.rootPath = root
		this.events = new Notificar()
		this.onceItemVisibleWatchers = new WeakMap()
		this.onceDirectoryExpandedWatchers = new WeakMap()
		this.onceDisposedWatchers = new WeakMap()
		this.onceParentChangedWatchers = new WeakMap()
		this.changeEventDispatchQueue = []
		this.fswatchers = new Map()
		super.setExpanded()
	}

	/**
	 * Path utils like `join`, `basename`, `dirname` etc.
	 *
	 * Use utils from this object to ensure all operations are compliant with path style as specified by the host
	 */
	public get pathfx() {
		return this._pathfx
	}

	public get expanded() {
		return true
	}

	public get path() {
		return this.rootPath
	}

	public onDidChangeDirExpansionState(cb: (directory: Directory, nowExpanded: boolean, visibleAtSurface: boolean) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidChangeExpansionState, cb)
	}

	public onWillChangeDirExpansionState(cb: (directory: Directory, nowExpanded: boolean) => void): IDisposable {
		return this.events.add(FileTreeEvent.WillChangeExpansionState, cb)
	}

	public onWillProcessWatchEvent(cb: (directory: Directory, event: IWatcherEvent) => void): IDisposable {
		return this.events.add(FileTreeEvent.WillProcessWatchEvent, cb)
	}
	public onDidProcessWatchEvent(cb: (directory: Directory, event: IWatcherEvent) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidProcessWatchEvent, cb)
	}

	public onDidUpdate(cb: () => void): IDisposable {
		return this.events.add(FileTreeEvent.BranchDidUpdate, cb)
	}

	public onWillDispose(cb: (target: FileOrDir) => void): IDisposable {
		return this.events.add(FileTreeEvent.WillDispose, cb)
	}

	public onDidDispose(cb: (target: FileOrDir) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidDispose, cb)
	}

	public onDidChangeParent(callback: (target: FileOrDir, prevParent: Directory, newParent: Directory) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidChangeParent, callback)
	}

	public onWillChangeParent(callback: (target: FileOrDir, prevParent: Directory, newParent: Directory) => void): IDisposable {
		return this.events.add(FileTreeEvent.WillChangeParent, callback)
	}

	public onDidChangePath(callback: (target: FileOrDir) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidChangePath, callback)
	}

	public onDidChangeMetadata(callback: (target: FileOrDir, change: IMetadataChange) => void): IDisposable {
		return this.events.add(FileTreeEvent.DidChangeMetadata, callback)
	}

	public onOnceChangeParent(target: FileOrDir, callback: (target: FileOrDir, prevParent: Directory, newParent: Directory) => void): IDisposable {
		if (!this.onceParentChangedWatchers.has(target)) {
			this.onceParentChangedWatchers.set(target, new Set())
		}
		const callbacks = this.onceParentChangedWatchers.get(target)
		callbacks.add(callback)
		return new Disposable(() => {
			callbacks.delete(callback)
			if (callbacks.size === 0) {
				this.onceDisposedWatchers.delete(target)
			}
		})
	}

	public onOnceDisposed(target: FileOrDir, callback: (target: FileOrDir) => void): IDisposable {
		if (target.disposed) {
			callback(target)
			return new Disposable(() => { })
		}
		if (!this.onceDisposedWatchers.has(target)) {
			this.onceDisposedWatchers.set(target, new Set())
		}
		const callbacks = this.onceDisposedWatchers.get(target)
		callbacks.add(callback)
		return new Disposable(() => {
			callbacks.delete(callback)
			if (callbacks.size === 0) {
				this.onceDisposedWatchers.delete(target)
			}
		})
	}

	public onOnceDirectoryExpanded(directory: Directory, callback: (directory: Directory) => void): IDisposable {
		if (directory.expanded) {
			callback(directory)
			return new Disposable(() => { })
		}
		if (!this.onceDirectoryExpandedWatchers.has(directory)) {
			this.onceDirectoryExpandedWatchers.set(directory, new Set())
		}
		const callbacks = this.onceDirectoryExpandedWatchers.get(directory)
		callbacks.add(callback)
		return new Disposable(() => {
			callbacks.delete(callback)
			if (callbacks.size === 0) {
				this.onceDirectoryExpandedWatchers.delete(directory)
			}
		})
	}

	public onOnceItemVisible(item: FileOrDir, callback: (item: FileOrDir) => void): IDisposable {
		if (this.isItemVisibleAtSurface(item)) {
			callback(item)
			return new Disposable(() => { })
		}
		if (!this.onceItemVisibleWatchers.has(item.parent)) {
			this.onceItemVisibleWatchers.set(item.parent, { item, disposer: new DisposablesComposite(), callbacks: new Set() })
		}
		const { callbacks, disposer } = this.onceItemVisibleWatchers.get(item.parent)
		callbacks.add(callback)
		const disposable = this.onDidChangeParent((t, prevParent, newParent) => {
			const subs = this.onceItemVisibleWatchers.get(prevParent)
			if (subs) {
				this.onceItemVisibleWatchers.set(newParent, subs)
				this.onceItemVisibleWatchers.delete(prevParent)
			}
		})

		return disposer.add(new Disposable(() => {
			callbacks.delete(callback)
			disposable.dispose()
			if (callbacks.size === 0) {
				this.onceItemVisibleWatchers.delete(item.parent)
			}
		}))
	}

	/**
	 * Like `readdirp` but much more sicker
	 *
	 * Iterates top down starting from first child of `startingPoint` (default `Root`) until exited
	 *
	 * ⚠ *THIS IS A UTILITY FUNCTION, DO NOT USE IT FOR FLATTENING TREE STRUCTURES* ⚠
	 *
	 * Flattened structure (for wiring with windowing libraries) is accessible through `Root.getFileEntryAtIndex`. Most windowing libraries will provide you
	 * with the `index` they need data for. Flattened structure available through `Root` is managed internally and `Root#branchSize` is the number of items
	 * visible at surface.
	 *
	 * Iterator will start at level `startingPoint#depth` (default `Root` thus `0`). To track `stepIns` and `stepOuts`, keep an eye on current item's `depth` (`FileEntry#depth`)
	 */
	public async iterateTopDown(callback: TopDownIteratorCallback, startingPoint: Directory = this) {
		const stack: Array<IterableIterator<FileOrDir>> = []
		let curIterable: IterableIterator<FileOrDir>
		let curItem: FileEntry | Directory = startingPoint
		let exited = false
		const exit = () => exited = true

		const stepIn = async () => {
			if (curItem.type !== FileType.Directory) {
				throw new Error(`stepIn can only be called on Directories`)
			}
			if (!(curItem as Root)._children) {
				await (curItem as Directory).ensureLoaded()
			}
			curIterable = (curItem as Root)._children.values()
			stack.push(curIterable)
			next()
		}

		const stepOut = () => {
			if (stack.length === 1) {
				throw new Error('Cannot stepOut of startingPoint')
			}
			curIterable = stack.pop()
			next()
		}
		const next = () => {
			curItem = curIterable.next().value
			if (exited) { return }
			callback(curItem, next, stepIn, stepOut, exit)
		}

		stepIn()
	}

	public expandDirectory(directory: Directory, ensureVisible = true) {
		return (directory as Root).setExpanded(ensureVisible)
	}

	public collapseDirectory(directory: Directory) {
		return (directory as Root).setCollapsed()
	}

	public inotify(event: IWatcherEvent): void {
		switch (event.type) {
			case WatchEvent.Moved:
				return this.dispatchWatchEvent(this.pathfx.dirname(event.oldPath), event)
			case WatchEvent.Removed:
				return this.dispatchWatchEvent(this.pathfx.dirname(event.path), event)
			case WatchEvent.Added:
				return this.dispatchWatchEvent(event.directory, event)
			case WatchEvent.Changed:
				return this.queueChangeEvent(event.directory)
		}
	}

	public getIndexAtFileEntryID(id: number) {
		return this.flattenedBranch.indexOf(id)
	}

	/**
	 * Reverse of `Root#getFileEntryAtIndex`
	 */
	public getIndexAtFileEntry(fileEntry: FileOrDir) {
		return this.flattenedBranch.indexOf(fileEntry.id)
	}

	/**
	 * Lookup flattened tree structure by index
	 *
	 * `Root` manages the flattened structure, which is automatically adjusted whenever a child Directory is expanded or collapsed
	 *
	 * Total number of items that "can" be visible at surface can be accessed by `Root#branchSize`
	 *
	 * Most windowing libraries will require you to specify item count, and upon rendering they will require data for an arbitrary index number
	 *
	 * Use `Root#branchSize` and `Root#getFileEntryAtIndex` respectively.
	 *
	 */
	public getFileEntryAtIndex(index: number) {
		const id = this.flattenedBranch[index]
		return FileEntry.getFileEntryById(id)
	}

	/**
	 * Looks up for given file or directory at path in the tree (pre-loaded tree only)
	 *
	 * This method, unlike `Root#forceLoadFileEntryAtPath`, WILL NOT, force load anything (synchronouse for that reason)
	 */
	public findFileEntryInLoadedTree(path: string): FileOrDir {
		const pathfrags = this.pathfx.isRelative(path) ? this.pathfx.splitPath(path) : this.walkPathTillRelative(path)
		if (pathfrags.length === 0) {
			return this
		}
		let next = this._children
		let fileName
		while (fileName = pathfrags.shift()) {
			const item = next.find((c) => c.fileName === fileName)
			if (item && pathfrags.length === 0) {
				return item
			}
			if (!item ||
				// we hit a dead end while we still had path to traverse
				(item.type === FileType.File && pathfrags.length > 0)) {
				throw new Error(`'${path}' not found`)
			}
			if (item.type === FileType.Directory) {
				if (!(item as Root)._children) {
					return null // the journey ends here
				}
				next = (item as Root)._children
			}
		}
	}

	/**
	 * Brute force variant of `Root#findFileEntryInLoadedTree`.
	 *
	 * This method will force load children of `Directory` if it comes in way of specified path. However, it will not affect visual state of tree.
	 */
	public async forceLoadFileEntryAtPath(path: string): Promise<Directory | FileEntry> {
		const pathfrags = this.pathfx.isRelative(path) ? this.pathfx.splitPath(path) : this.walkPathTillRelative(path)
		if (pathfrags.length === 0) {
			return this
		}
		await this.ensureLoaded()
		let next = this._children
		let fileName
		while (fileName = pathfrags.shift()) {
			const item = next.find((c) => c.fileName === fileName)
			if (item && pathfrags.length === 0) {
				return item
			}
			if (!item ||
				// we hit a dead end while we still had path to traverse
				(item.type === FileType.File && pathfrags.length > 0)) {
				throw new Error(`'${path}' not found`)
			}
			if (item.type === FileType.Directory) {
				if (!(item as Root)._children) {
					await (item as Root).hardReloadChildren()
				}
				next = (item as Root)._children
			}
		}
	}

	/**
	 * Checks if an item is visible at surface, as opposed to being buried in the tree.
	 *
	 * "Visible" here does not mean visible in the current view/scroll state of rendered content. Instead, it means the item "can" be visible if scolled to the right spot.
	 *
	 * "Buried" means that item may (or may not) be inside an expanded directory, but at least one of its parent directory is in collapsed state preventing it
	 * from being "visible" at surface.
	 */
	public isItemVisibleAtSurface(item: FileOrDir): boolean {
		if (item === this) {
			return true
		}
		return this.flattenedBranch.indexOf(item.id) > -1
	}

	public setExpanded(ensureVisible?: boolean): Promise<void> {
		// noop: Root cannot be expanded
		return
	}

	public setCollapsed() {
		// noop: Root cannot be collapsed
		return
	}

	public async flushEventQueue() {
		if (this.changeEventDispatchQueue.length === 0) {
			return
		}
		this.changeEventDispatchQueue.sort((pathA, pathB) => {
			const pathADepth = this.pathfx.pathDepth(pathA)
			const pathBDepth = this.pathfx.pathDepth(pathB)
			return pathADepth - pathBDepth
		})
		const promise = pSeries(this.changeEventDispatchQueue.map((path) => async () => {
			const watcher = this.fswatchers.get(path)
			if (watcher && typeof watcher.callback === 'function') {
				await watcher.callback({ type: WatchEvent.Changed, directory: path })
			}
			return null
		}) as any)
		// reset the queue
		this.changeEventDispatchQueue = []
		return promise
	}

	protected setFlattenedBranch(branch: Uint32Array) {
		this.flattenedBranch = branch
		this.events.dispatch(FileTreeEvent.BranchDidUpdate)
	}

	private walkPathTillRelative(path: string): string[] {
		if (typeof path !== 'string') {
			throw new TypeError('Path must of type string')
		}
		const { splitPath, join } = this.pathfx
		const pathfrags = splitPath(path)
		const rootPrefix = splitPath(this.path)
		let nextRootFrag
		const matched = []
		while (nextRootFrag = rootPrefix.shift()) {
			if (nextRootFrag === pathfrags[0]) {
				matched.push(pathfrags.shift())
			} else {
				throw new Error(`'${path}' stopped matching after '${join(...matched)}'`)
			}
		}
		return pathfrags
	}

	/**
	 * FileTreeView's watcher queues up FS events instead of dispatching them immediately for performance reasons
	 * Event queue is flushed after 't' milliseconds after last FS event is dispatched by host.
	 * Call it directly if some component requires FileTreeView to be up to date with any changes.
	 *
	 * ONLY GENERIC CHANGE EVENTS ARE QUEUED, OTHER SPECIFIC EVENTS ARE DISPATCHED AS THEY COME
	 */
	private queueChangeEvent(abspath: string) {
		clearTimeout(this.eventFlushTimeout)
		this.eventFlushTimeout = setTimeout(this.flushEventQueue, 150) as any
		// ensure no duplicates
		if (this.changeEventDispatchQueue.indexOf(abspath) === -1) {
			this.changeEventDispatchQueue.push(abspath)
		}
	}

	private dispatchWatchEvent(path: string, event: IWatcherEvent) {
		const watcher = this.fswatchers.get(this.pathfx.normalize(path))
		if (watcher && watcher.callback) {
			watcher.callback(event)
		}
	}

	private terminateWatch(path: string) {
		this.fswatchers.delete(this.pathfx.normalize(path))
	}

}
