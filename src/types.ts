import { Directory } from './Directory'
import { FileEntry } from './FileEntry'

export enum FileTreeEvent {
	WillChangeExpansionState = 1,
	DidChangeExpansionState,
	WillChangeParent,
	DidChangeParent,
	WillDispose,
	DidDispose,
	BranchDidUpdate,
	DidChangePath,
	DidProcessWatchEvent,
	WillProcessWatchEvent,
	DidChangeMetadata,
}

export enum MetadataChangeType {
	Added = 1,
	Updated,
	Removed,
}

export interface IMetadataChange {
	type: MetadataChangeType,
	key: string
	prevValue: any
	value: any
}

/**
 * Every `Root` has one `TreeSupervisor` created at the very moment a `Root` is created
 *
 * It exists to facilitate event delegation for events originiating somewhere down in the tree and other bunch of shared stuff (shared in the tree, but unique to each `Root`)
 */
export interface ITreeSupervisor {

	// Helpers //
	supervisedWatch(path: string, callback: WatcherCallback)

	// Event delegations //

	notifyWillChangeParent(target: FileEntry | Directory, prevParent: Directory, newParent: Directory)
	notifyDidChangeParent(target: FileEntry | Directory, prevParent: Directory, newParent: Directory)

	notifyWillDispose(target: FileEntry | Directory)
	notifyDidDispose(target: FileEntry | Directory)

	notifyWillProcessWatchEvent(target: Directory, event: IWatcherEvent)
	notifyDidProcessWatchEvent(target: Directory, event: IWatcherEvent)

	notifyWillChangeExpansionState(target: Directory, nowExpanded: boolean)
	notifyDidChangeExpansionState(target: Directory, nowExpanded: boolean)

	notifyDidChangePath(target: FileEntry | Directory)
	notifyDidChangeMetadata(target: FileEntry | Directory, change: IMetadataChange)
}

/**
 * A 'raw' minimal description of file or directory
 *
 * This will be converted to either `FileEntry` or `Directory` object
 *
 * It does not need to be serializable
 */
export interface IFileEntryItem {
	/**
	 * Name of the file or directory
	 *
	 * If a path is given, it'll work fine as the basename will be extracted automatically
	 */
	readonly name: string

	/**
	 * Type of file
	 *
	 * Avoid hardcoding the numerical value, instead, use the `FileType` enum to select either `File` or `Directory`
	 */
	readonly type: FileType

	/**
	 * Optional Metadata/Attributes
	 *
	 * Can be literally anything. `aspen` does not use this data in any way or shape.
	 *
	 * This object will set initial metadata.
	 *
	 * Additional metadata can be added using `FileEntry#addMetadata` (existing metadata can be updated using same method).
	 *
	 * You can get the value of key using `FileEntry#getMetadata`. And can be removed using `FileEntry#removeMetadata`
	 *
	 * You can use `Root#onDidChangeMetadata` hook to get notified whenever a `FileEntry`'s metadata is changed, added or removed.
	 *
	 * Examples:
	 *  - Your own state tracking systems
	 *  - Your own event management stuff
	 *  - `ctime`, `mtime`, `size`, you name it
	 */
	readonly metadata?: { [key: string]: any }
}

export enum FileType {
	File = 1,
	Directory,
}

/**
 * Function that when called should terminate a watch session associated with a directory
 */
export type WatchTerminator = (path?: string) => void

/**
 * Iterator callback as expected by `Root#iterateTopDown`
 */
export type TopDownIteratorCallback =
/**
 * @param item Current FileEntry or Directory item
 * @param stepOver Jump to next item at same level (meaning if current item is `Directory`, it won't go "inside")
 * @param stepIn If current item is Directory, jump "inside" and current item becomes it's first child
 * @param stepOut Back out of current Directory i.e one level out
 * @param exit Exit the iterator
 */
(item: FileOrDir, stepOver: () => void, stepIn: () => void, stepOut: () => void, exit: () => void) => void

export interface IBasicFileSystemHost {
	/**
	 * Path style `aspen` should stick to for the duration of its existence
	 *
	 * Valid values are `win32` or `unix`. Invalid value will implicitly mean `unix`.
	 *
	 * Once `Root` is set up, almost all of the common path utils can be accessed through `Root#pathfx` object. Utils in this object are 100% compliant with specified `pathStyle`
	 *
	 * Notes:
	 *  - `win32` paths are separated by backslash (`\`) as well as forward slash (`/`), but if `aspen` needs to merge paths, it'll only use `\` for that purpose
	 *  - `unix` paths are separated ONLY by forward slash (`/`). Backslashes (`\`) in `unix` paths become part of the filename.
	 */
	readonly pathStyle: 'win32' | 'unix'

	/**
	 * Just slightly more than unix's `ls` command
	 *
	 * Called when a Directory loads its contents
	 *
	 * Do not waste computational time on sorting items just yet, return them as is (Specify `host.sortComparator` instead)
	 *
	 * There is no need to sort raw items. The parent `Directory` will call your `sortComparator` function (if specified) once raw items are converted to "real" objects
	 *
	 * Array of { name: string, type: FileType, attributes?: {[key: string]: any}}
	 */
	getItems: (path: string) => IFileEntryItem[] | Promise<IFileEntryItem[]>

	/**
	 * Sorting comparator Directories should use when:
	 *  - Directory is expanded for first time
	 *  - `Root#forceLoadFileEntryAtPath` is called and the target exists in a `Directory` that was not expaned previously (thus triggering a hard reload)
	 *  - On `WatchEvent.Moved`, `WatchEvent.Added` and `WatchEvent.Changed` (but not on `WatchEvent.Removed`)
	 *
	 * REMINDER: Avoid using `instanceof` when checking if an item is `Directory` or `FileEntry`. `instanceof` is computationally expensive and not required for this purpose.
	 * Use `item.type === FileType.File` to check if item is `FileEntry` and `item.type === FileType.Directory` to check for `Directory`
	 */
	sortComparator?: (a: FileEntry | Directory, b: FileEntry | Directory) => number

	/**
	 * File watching
	 *
	 * This method will be called whenever a Directory loads its contents to let the host know that aspen will be expecting notifications if any file(s) get added/removed/moved
	 *
	 * Host and UI can stay in a perfect sync if host is good at notifying aspen about any changes.
	 *
	 * Hereafter, use `Root#inotify` to dispatch the events (dispatch a properly formatted `IWatcherEvent` and `Root` will take care of the rest)
	 *
	 * `watch` must return a function that `aspen` can call to terminate a watch session when it's no longer needed. The returned function will be called with the same path
	 * which was used to start the watch in first place.
	 *
	 * *It is recommended that instead of returning a new function reference everytime, all calls to `watch` should return same function for each watch. That one function can
	 * take the path parameter and terminate the associated watcher accordingly.*
	 *
	 */
	watch?: (path: string) => WatchTerminator
}

export type FileOrDir = FileEntry | Directory

export type WatcherCallback = (event: IWatcherEvent) => void

export type IWatcherEvent = IWatcherChangeEvent | IWatcherAddEvent | IWatcherRemoveEvent | IWatcherMoveEvent

export enum WatchEvent {
	Added = 1,

	Removed,

	/**
	 * Avoid dispatching this at all costs!!
	 *
	 * This event will cause a HARD reset on the directory it is dispatched at
	 */
	Changed,

	/**
	 * Represents a move event
	 *
	 * `WatchEvent.Moved` is also used to represent rename events. Example, `'${dirname}/${oldName}'` = `oldPath` and similarly, `'${dirname}/${newName}'` = `newPath`
	 */
	Moved,
}

/**
 * Avoid dispatching this at all costs
 *
 * Expansion state of sub-directories WILL NOT be preserved since it's a hard reset at target level
 *
 * Optionally you can use `TreeStateWatcher#snapshot` before dispatching `Change` event, then mount the snapshot afterwards to attempt expansion state restore
 */
export interface IWatcherChangeEvent {
	type: WatchEvent.Changed
	/**
	 * Path to directory that changed
	 */
	directory: string
}

export interface IWatcherAddEvent {
	type: WatchEvent.Added
	/**
	 * Path to directory that will parent new file
	 */
	directory: string
	/**
	 * Describe the file
	 */
	file: IFileEntryItem
}

export interface IWatcherRemoveEvent {
	type: WatchEvent.Removed
	/**
	 * Path to file that is no longer existent
	 */
	path: string
}

export interface IWatcherMoveEvent {
	type: WatchEvent.Moved
	/**
	 * Old (absolute) path of file/directory
	 */
	oldPath: string
	/**
	 * New (absolute) path of file/directory
	 */
	newPath: string
}
