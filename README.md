# Aspen Core

The *most* performant solution for syncing dynamic nested objects/trees with their flattened representation. Aspen trees are powered by superfast `TypedArrays`
that are `~5x` faster than regular Arrays in all operations like lookups (`indexOf`) and alterations (`splice`), which means best of the best.

Aspen was built to serve `react-aspen`, a library for displaying nested trees in React apps (like file trees, indented todo lists etc.) while ensuring
everything is super-efficient.

It is recommended that you read [documentation](https://github.com/neeksandhu/react-aspen) for `react-aspen` to get a better idea on what this is all about.

## Usage

> You shouldn't have to use this library "as is" unless you're porting `react-aspen` to another rendering library and you need a very efficient backend

### Install

```bash
npm i aspen-core
```

### Light it up

```typescript
import * as fse from 'fs-extra'
import * as Path from 'path'
import { IBasicFileSystemHost, Root, IFileEntryItem, WatchTerminator, FileType } from 'aspen-core'

const host: IBasicFileSystemHost = {
    pathStyle: 'unix', // or 'win32'
    getItems: async (path: string): Promise<IFileEntryItem[]> => Promise.all(
        (await fse.readdir(path))
            .map(async (filename) => {
                const stat = await fse.stat(Path.join(path, filename))
                return {
                    name: filename,
                    type: stat.isDirectory() ? FileType.Directory : FileType.File
                }
            })),

    /**
     * [optional] sort function
     */
    // sortComparator: (a: FileOrDir, b: FileOrDir): number => { by default Directories come before FileEntries }

    /**
     * [optional] use this to know when a Directory is interested in file watching
     * Note that this is used just to let you "know", `Root` can receive events through `Root#inotify` regardless of this method's presence
     */
    // watch: (path: string): WatchTerminator => { return a function that will be called when a Directory is no longer interested in watching changes }
}

const root: Root = new Root(host, '/absolute/path/that/will/act/as/root')

// refer to the full API on what is possible next
```

### API

This library is written in TypeScript. Type definitions are included when you do `npm i aspen-core`. Documentaion is available [here](https://neeksandhu.github.io/aspen-core/classes/root).

## License

This project is licensed under MIT license. You are free to use, modify, distribute the code as you like (credits although not required, are highly appreciated)
