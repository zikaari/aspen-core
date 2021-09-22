import { Directory } from './Directory'
import { Root } from './Root'
import { FileType, IFileEntryItem, ITreeSupervisor, MetadataChangeType } from './types'

export class FileEntry {
	public static nextId = (() => {
		let id = 0
		return () => id++
	})()

	public static checkRawFile(file: IFileEntryItem) {
		if (file === null || typeof file !== 'object') {
			throw new TypeError(`Item must be IFileEntryItem object. See docs for more info`)
		}
		if (file.type !== FileType.Directory && file.type !== FileType.File) {
			throw new TypeError(`IFileEntryItem must have a 'type' property which is either FileType.File or FileType.Directory`)
		}
		if (typeof file.name !== 'string') {
			throw new TypeError(`IFileEntryItem must have a 'name' property of type string`)
		}
	}

	public static getFileEntryById(id: number) {
		return FileEntry.idToFileEntry.get(id)
	}

	private static idToFileEntry: Map<number, FileEntry> = new Map()
	protected _uid: number
	protected _depth: number
	protected _fileName: string
	protected _superv: ITreeSupervisor
	private _metadata: { [key: string]: any }
	private _root: Root
	private _parent: Directory
	private _disposed: boolean
	private resolvedPathCache: string

	protected constructor(root: Root, tree: ITreeSupervisor, parent: Directory, fileName: string, optionalMetadata?: { [key: string]: any }) {
		this._uid = FileEntry.nextId()
		this._root = root ? root : (this as any) as Root // 'this' IS Root
		this._parent = parent
		this._superv = tree
		this._disposed = false
		this._metadata = { ...(optionalMetadata || {}) }
		this._depth = parent ? parent.depth + 1 : 0
		if (parent && typeof fileName === 'string') {
			this._fileName = fileName
		}
		FileEntry.idToFileEntry.set(this._uid, this)
	}

	get type(): FileType {
		return FileType.File
	}

	/**
	 * `disposed` status of this item
	 *
	 * Once an item is disposed, it's best to let go of all references to it to avoid any memory leaks
	 */
	get disposed() { return this._disposed }

	/**
	 * Hierarchial depth of this item relative to the `Root`
	 */
	get depth() { return this._depth }
	get root() { return this._root }
	get parent() { return this._parent }
	get id() { return this._uid }
	get fileName() { return this._fileName }

	/**
	 * Full absolute path of this item
	 */
	get path(): string {
		if (!this.parent) {
			throw new Error(`orphaned/detached FileEntries don't have path (except Root)`)
		}
		if (!this.resolvedPathCache) {
			if (this.root.pathfx.isRelative(this.fileName)) {
				this.resolvedPathCache = this.root.pathfx.join(this.parent.path, this.fileName)
			} else {
				this.resolvedPathCache = this.fileName
			}
		}
		return this.resolvedPathCache
	}

	/**
	 * Very much like `unix`s `mv` command
	 *
	 * Calling this method directly WILL NOT trigger `onWillHandleWatchEvent` and `onDidHandleWatchEvent` events
	 *
	 * Prefer using `Root#inotify` instead
	 */
	public mv(to: Directory, fname: string = this.fileName) {
		const prevParent = this._parent
		if (to === null || to.type !== FileType.Directory) { // that's the best check we can do; `parent instanceof Directory` causes a cyclic dependency
			this.dispose()
			this._parent = null
			prevParent.unlinkItem(this)
			return
		}
		const didChangeParent = prevParent !== to
		const prevPath = this.path

		this.resolvedPathCache = null
		this._depth = to._depth + 1

		if (didChangeParent || fname !== this.fileName /* change in filename means change in sort order */) {
			this._fileName = fname
			if (didChangeParent) {
				this._superv.notifyWillChangeParent(this, prevParent, to)
			}
			this._parent.unlinkItem(this, true)
			this._parent = to
			this._parent.insertItem(this)
			if (didChangeParent) {
				this._superv.notifyDidChangeParent(this, prevParent, to)
			}
		}

		if (this.path !== prevPath) {
			this._superv.notifyDidChangePath(this)
		}
	}

	public getMetadata(withKey: string): any {
		return this._metadata[withKey]
	}

	public addMetadata(withKey: string, value: any) {
		if (!(withKey in this._metadata)) {
			this._metadata[withKey] = value
			this._superv.notifyDidChangeMetadata(this, { type: MetadataChangeType.Added, key: withKey, prevValue: void 0, value })
		} else {
			const prevValue = this._metadata[withKey]
			this._metadata[withKey] = value
			this._superv.notifyDidChangeMetadata(this, { type: MetadataChangeType.Updated, key: withKey, prevValue, value })
		}
	}

	public removeMetadata(withKey: string) {
		if (withKey in this._metadata) {
			const prevValue = this._metadata[withKey]
			delete this._metadata[withKey]
			this._superv.notifyDidChangeMetadata(this, { type: MetadataChangeType.Removed, key: withKey, prevValue, value: void 0 })
		}
	}

	protected dispose() {
		if (this._disposed) { return }
		this._superv.notifyWillDispose(this)
		this._disposed = true
		FileEntry.idToFileEntry.delete(this._uid)
		this._superv.notifyDidDispose(this)
	}
}
