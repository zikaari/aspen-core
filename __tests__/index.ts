import { Directory, FileType, IBasicFileSystemHost, Root } from '../src'

const sampleTree = {
    app: {
        tests: {
            'index.ts': '',
        },
        src: {
            components: {
                Header: {
                    'index.ts': '',
                    'styles.sass': '',
                },
            },
            models: {
                user: {
                    'index.ts': '',
                },
            },
        },
        scripts: {
            build: {
                'prod.ts': '',
                'dev.sass': '',
            },
        },
    },
}

function findNode(path: string[], tree) {
    if (!path || path.length === 0) {
        return tree
    }
    const next = path.shift()
    return findNode(path, tree[next])
}

const host: IBasicFileSystemHost = {
    pathStyle: 'unix',
    async getItems(path) {
        const node = findNode(path.match(/[^\/]+/g), sampleTree)
        return Object.keys(node).map((fname) => ({
            name: fname,
            type: typeof node[fname] === 'string' ? FileType.File : FileType.Directory,
        }))
    },
}

describe('Root', () => {
    let root: Root
    it('constructs with errors', () => { root = new Root(host, '/app') })
    it('starts of expanded', async () => {
        await root.ensureLoaded()
        expect(root.children.length).toBe(Object.keys(sampleTree.app).length)
        expect(root.branchSize).toBe(Object.keys(sampleTree.app).length)
    })

    let srcH: Directory
    it('returns a Handle to item', async () => {
        srcH = await root.forceLoadFileEntryAtPath('/app/src') as Directory
        expect(srcH).toBeInstanceOf(Directory)
    })

    it('expands a directory (at depth 0)', async () => {
        expect(srcH.expanded).toBe(false)
        await root.expandDirectory(srcH, true)
        expect(srcH.expanded).toBe(true)
        expect(root.branchSize).toBe(Object.keys(sampleTree.app).length + Object.keys(sampleTree.app.src).length)
    })

    it('collapses a directory (at depth 0)', async () => {
        expect(srcH.expanded).toBe(true)
        root.collapseDirectory(srcH)
        expect(srcH.expanded).toBe(false)
        expect(root.branchSize).toBe(Object.keys(sampleTree.app).length)
    })

    let srcModelsH: Directory
    it('expands a sub-directory (at depth 1) w/o alterning "at surface" visual state', async () => {
        srcModelsH = await root.forceLoadFileEntryAtPath('/app/src/models') as Directory
        expect(srcModelsH.expanded).toBe(false)
        await root.expandDirectory(srcModelsH, false)
        expect(srcModelsH.expanded).toBe(true)
        expect(root.branchSize).toBe(Object.keys(sampleTree.app).length)
    })

    it('(re)expands a directory (at depth 0) (keeping its just expanded subdir in mind)', async () => {
        expect(srcH.expanded).toBe(false)
        await root.expandDirectory(srcH, true)
        expect(srcH.expanded).toBe(true)
        expect(root.branchSize).toBe(
            Object.keys(sampleTree.app).length +
            Object.keys(sampleTree.app.src).length +
            Object.keys(sampleTree.app.src.models).length)
    })
})
