import { FileEntry } from './FileEntry'
import { Root } from './Root'
import { FileType, IWatcherEvent, WatchEvent, WatchTerminator } from './types'
import { ITreeSupervisor } from './types'

/**
 * Like Array.prototype.splice except this method won't throw
 * RangeError when given too many items (with spread operator as `...items`)
 *
 * Also items are concated straight up without having to use the spread operator
 *
 * Performance is more or less same as Array.prototype.splice
 *
 * @param arr Array to splice
 * @param start Start index where splicing should begin
 * @param deleteCount Items to delete (optionally replace with given items)
 * @param items Items to insert (when deleteCount is same as items.length, it becomes a replace)
 */
function spliceTypedArray(arr: Uint32Array, start: number, deleteCount: number = 0, items?: Uint32Array) {
	const a = new Uint32Array((arr.length - deleteCount) + (items ? items.length : 0))
	a.set(arr.slice(0, start))
	if (items) {
		a.set(items, start)
	}
	a.set(arr.slice(start + deleteCount, arr.length), (start + (items ? items.length : 0)))
	return a
}

export class Directory extends FileEntry {
	public static defaultSortComparator(a: FileEntry | Directory, b: FileEntry | Directory) {
		if (a.constructor === b.constructor) {
			return a.fileName > b.fileName ? 1
				: a.fileName < b.fileName ? -1
					: 0
		}
		return a.constructor === Directory ? -1
			: b.constructor === Directory ? 1
				: 0
	}

	protected _children: Array<Directory | FileEntry>
	/**
	 * Directory.children.length of self and all leafs (recursive) with isExpanded = true
	 */
	protected _branchSize: number
	protected flattenedBranch: Uint32Array
	private isExpanded: boolean
	private watchTerminator: WatchTerminator
	private hardReloadPromise: Promise<void>
	private hardReloadPResolver: () => void
	protected constructor(root: Root, tree: ITreeSupervisor, parent: Directory, dirName: string, optionalMetadata?: { [key: string]: any }) {
		super(root, tree, parent, dirName, optionalMetadata)
		this.isExpanded = false
		this._branchSize = 0
		this._children = null
	}

	get type(): FileType {
		return FileType.Directory
	}

	get children() {
		return this._children ? this._children.slice() : null
	}

	get expanded() {
		return this.isExpanded
	}

	/**
	 * Number of *visible* flattened leaves this branch is incharge of (recursive)
	 *
	 * When a directory is expanded, its entire branch (recursively flattened) is owned by a branch higher up (either Root (at surface) or a branch in collapsed state (buried))
	 *
	 * When a directory is collapsed, its entire branch (recursively flattened) is "returned" back to it by one of its parent higher up
	 */
	get branchSize() {
		return this._branchSize
	}

	/**
	 * Ensures the children of this `Directory` are loaded (without effecting the `expanded` state)
	 *
	 * If children are already loaded, returned `Promise` resolves immediately
	 *
	 * Otherwise a hard reload request is issued and returned `Promise` resolves when that process finishes.
	 *
	 * tl;dr: `Directory#children` are accessible once the returned `Promise` resolves
	 */
	public async ensureLoaded() {
		if (this._children) {
			return
		}
		return this.hardReloadChildren()
	}

	public async setExpanded(ensureVisible = true) {
		if (this.isExpanded) {
			return
		}
		this.isExpanded = true
		if (this._children === null) {
			await this.hardReloadChildren()

			// check if still expanded; maybe setCollapsed was called in the meantime
			if (!this.isExpanded) {
				return
			}
		}

		if (ensureVisible && this.parent && this.parent !== this.root) {
			await this.parent.setExpanded(true)
		}

		// async (user might have changed their mind in the meantime)
		if (this.isExpanded) {
			this._superv.notifyWillChangeExpansionState(this, true)
			this.expandBranch(this)
			this._superv.notifyDidChangeExpansionState(this, true)
		}
	}

	public setCollapsed() {
		if (!this.isExpanded) {
			return
		}
		if (this._children && this.parent) {
			this._superv.notifyWillChangeExpansionState(this, false)
			this.shrinkBranch(this)
		}
		this.isExpanded = false

		this._superv.notifyDidChangeExpansionState(this, false)
	}

	/**
	 * Inserts the item into it's own parent (if not already)
	 *
	 * Gets called upon `IWatcherAddEvent` or `IWatcherMoveEvent`
	 *
	 * Calling this method directly WILL NOT trigger `onWillHandleWatchEvent` and `onDidHandleWatchEvent` events
	 *
	 * Prefer using `Root#inotify` instead
	 */
	public insertItem(item: FileEntry | Directory) {
		if (item.parent !== this) {
			item.mv(this, item.fileName)
			return
		}
		if (this._children.indexOf(item) > -1) {
			return
		}
		const branchSizeIncrease = 1 + ((item instanceof Directory && item.expanded) ? item._branchSize : 0)
		this._children.push(item)
		this._children.sort(this.root.host.sortComparator || Directory.defaultSortComparator)
		this._branchSize += branchSizeIncrease
		let master: Directory = this
		while (!master.flattenedBranch) {
			if (master.parent) {
				master = master.parent
				master._branchSize += branchSizeIncrease
			}
		}
		let relativeInsertionIndex = this._children.indexOf(item)
		const leadingSibling = this._children[relativeInsertionIndex - 1]
		if (leadingSibling) {
			const siblingIdx = master.flattenedBranch.indexOf(leadingSibling.id)
			relativeInsertionIndex = siblingIdx + ((leadingSibling instanceof Directory && leadingSibling.expanded) ? leadingSibling._branchSize : 0)
		} else {
			relativeInsertionIndex = master.flattenedBranch.indexOf(this.id)
		}
		const absInsertionIndex = relativeInsertionIndex + 1 // +1 to accomodate for itself

		const branch = new Uint32Array(branchSizeIncrease)
		branch[0] = item.id
		if (item instanceof Directory && item.expanded && item.flattenedBranch) {
			branch.set(item.flattenedBranch, 1)
			item.setFlattenedBranch(null)
		}
		master.setFlattenedBranch(spliceTypedArray(master.flattenedBranch, absInsertionIndex, 0, branch))
	}

	/**
	 * Removes the item from parent
	 *
	 * Gets called upon `IWatcherRemoveEvent` or `IWatcherMoveEvent`
	 *
	 * Calling this method directly WILL NOT trigger `onWillHandleWatchEvent` and `onDidHandleWatchEvent` events
	 *
	 * Prefer using `Root#inotify` instead
	 */
	public unlinkItem(item: FileEntry | Directory, reparenting: boolean = false): void {
		const idx = this._children.indexOf(item)
		if (idx === -1) {
			return
		}
		this._children.splice(idx, 1)
		const branchSizeDecrease = 1 + ((item instanceof Directory && item.expanded) ? item._branchSize : 0)
		this._branchSize -= branchSizeDecrease
		// find out first owner of topDownFlatLeaves struct
		let master: Directory = this
		while (!master.flattenedBranch) {
			if (master.parent) {
				master = master.parent
				master._branchSize -= branchSizeDecrease
			}
		}
		const removalBeginIdx = master.flattenedBranch.indexOf(item.id)
		if (removalBeginIdx === -1) {
			return
		}
		// is directory and DOES NOT owns its leaves (when directory is expanded, its leaves are owned by someone higher up) (except during transfers)
		if (item instanceof Directory && item.expanded) {
			item.setFlattenedBranch(master.flattenedBranch.slice(removalBeginIdx + 1, removalBeginIdx + branchSizeDecrease))
		}
		master.setFlattenedBranch(spliceTypedArray(
			master.flattenedBranch,
			removalBeginIdx,
			branchSizeDecrease))

		if (!reparenting && item.parent === this) {
			item.mv(null)
		}
	}

	public mv(to: Directory, newName: string = this.fileName) {
		// get the old path before `super.mv` refreshes it
		const prevPath = this.path

		super.mv(to, newName)

		// when `to` is null, it means the item is detached from the tree and disposed off
		if (this.disposed) {
			return
		}

		if (typeof this.watchTerminator === 'function') {
			this.watchTerminator(prevPath)
			// If we got children, we gotta watch em'!
			if (this._children) {
				this.watchTerminator = this._superv.supervisedWatch(this.path, this.handleWatchEvent)
			}
		}
		if (this._children) {
			for (let i = 0; i < this._children.length; i++) {
				const child = this._children[i]
				// It'll reset the cached resolved path
				child.mv(child.parent, child.fileName)
			}
		}
	}

	/**
	 * WARNING: This will only stop watchers and clear bookkeeping records
	 * To clean-up flattened branches and stuff, call Directory#removeItem in the parent
	 * Directory#removeItem will call Directory#dispose anyway
	 */
	protected dispose() {
		if (typeof this.watchTerminator === 'function') {
			this.watchTerminator(this.path)
		}
		if (this._children) {
			this._children.forEach((child) => (child as Directory).dispose())
		}
		super.dispose()
	}

	/**
	 * Using setter as Root needs to capture when the root flat tree is altered
	 */
	protected setFlattenedBranch(leaves: Uint32Array) {
		this.flattenedBranch = leaves
	}

	protected expandBranch(branch: Directory) {
		if (this !== branch) {
			this._branchSize += branch._branchSize
		}
		// when `this` itself is in collapsed state, it'll just "adopt" given branch's leaves without propagating any further up
		if (this !== branch && this.flattenedBranch) {
			const injectionStartIdx = this.flattenedBranch.indexOf(branch.id) + 1
			this.setFlattenedBranch(spliceTypedArray(this.flattenedBranch, injectionStartIdx, 0, branch.flattenedBranch))
			// [CRITICAL] take "away" the branch ownership
			branch.setFlattenedBranch(null)
		} else if (this.parent) {
			this.parent.expandBranch(branch)
		}
	}

	protected shrinkBranch(branch: Directory) {
		if (this !== branch) {
			// branch size for `this` hasn't changed, `this` still has same number of leaves, but from parents frame of reference, their branch has shrunk
			this._branchSize -= branch._branchSize
		}
		if (this !== branch && this.flattenedBranch) {
			const removalStartIdx = this.flattenedBranch.indexOf(branch.id) + 1
			// [CRITICAL]  "return" the branch ownership
			branch.setFlattenedBranch(this.flattenedBranch.slice(removalStartIdx, removalStartIdx + branch._branchSize))
			this.setFlattenedBranch(spliceTypedArray(this.flattenedBranch, removalStartIdx, branch.flattenedBranch.length))
		} else if (this.parent) {
			this.parent.shrinkBranch(branch)
		}
	}

	protected async hardReloadChildren() {
		if (this.hardReloadPromise) {
			return this.hardReloadPromise
		}
		this.hardReloadPromise = new Promise((res) => this.hardReloadPResolver = res)
		this.hardReloadPromise.then(() => {
			this.hardReloadPromise = null
			this.hardReloadPResolver = null
		})

		const rawItems = await this.root.host.getItems(this.path) || []
		if (this._children) {
			this.shrinkBranch(this) // VERY CRITICAL (we need the ownership of topDownFlatLeaves so we can reset it)
		}
		const flatTree = new Uint32Array(rawItems.length)
		this._children = Array(rawItems.length)
		for (let i = 0; i < rawItems.length; i++) {
			const file = rawItems[i]
			if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
				FileEntry.checkRawFile(file)
			}
			const { type, name, metadata } = file
			const child = new (type === FileType.Directory ? Directory : FileEntry)(this.root, this._superv, this, name, metadata)
			this._children[i] = child
		}

		this._children.sort(this.root.host.sortComparator || Directory.defaultSortComparator)

		for (let i = 0; i < rawItems.length; i++) {
			flatTree[i] = this._children[i].id
		}
		this._branchSize = flatTree.length
		this.setFlattenedBranch(flatTree)
		if (typeof this.watchTerminator === 'function') {
			this.watchTerminator(this.path)
		}

		this.watchTerminator = this._superv.supervisedWatch(this.path, this.handleWatchEvent)
		this.hardReloadPResolver()
	}

	private handleWatchEvent = async (event: IWatcherEvent) => {
		this._superv.notifyWillProcessWatchEvent(this, event)
		if (event.type === WatchEvent.Moved) {
			const { oldPath, newPath } = event
			if (typeof oldPath !== 'string') { throw new TypeError(`Expected oldPath to be a string`) }
			if (typeof newPath !== 'string') { throw new TypeError(`Expected newPath to be a string`) }
			if (this.root.pathfx.isRelative(oldPath)) { throw new TypeError(`oldPath must be absolute`) }
			if (this.root.pathfx.isRelative(newPath)) { throw new TypeError(`newPath must be absolute`) }
			this.transferItem(oldPath, newPath)
		} else if (event.type === WatchEvent.Added) {
			const { file } = event
			FileEntry.checkRawFile(file)
			const newItem = new (file.type === FileType.Directory ? Directory : FileEntry)(this.root, this._superv, this, file.name, file.metadata)
			this.insertItem(newItem)
		} else if (event.type === WatchEvent.Removed) {
			const { path } = event
			const dirName = this.root.pathfx.dirname(path)
			const fileName = this.root.pathfx.basename(path)
			if (dirName === this.path) {
				const item = this._children.find((c) => c.fileName === fileName)
				if (item) {
					this.unlinkItem(item)
				}
			}
		} else /* Maybe generic change event */ {
			// TODO: Try to "rehydrate" tree instead of hard reset (if possible) (maybe IFileEntryItem can have optional `id` prop? hash of (ctime + [something])?)
			for (let i = 0; i < this._children.length; i++) {
				(this._children[i] as Directory).dispose()
			}
			this.hardReloadChildren()
		}
		this._superv.notifyDidProcessWatchEvent(this, event)
	}

	private transferItem(oldPath: string, newPath: string) {
		const { dirname, basename } = this.root.pathfx
		const from = dirname(oldPath)
		if (from !== this.path) {
			return
		}
		const fileName = basename(oldPath)
		const item = this._children.find((c) => c.fileName === fileName)
		if (!item) {
			return
		}
		const to = dirname(newPath)
		const destDir = to === from ? this : this.root.findFileEntryInLoadedTree(to)
		if (!(destDir instanceof Directory)) {
			this.unlinkItem(item)
			return
		}
		item.mv(destDir, basename(newPath))
	}
}
