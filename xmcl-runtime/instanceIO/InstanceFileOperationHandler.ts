import { DownloadTask } from '@xmcl/installer'
import { ModrinthV2Client } from '@xmcl/modrinth'
import { InstanceFile, InstanceFileWithOperation, Resource, ResourceDomain, ResourceMetadata, TaskRoutine } from '@xmcl/runtime-api'
import { Task } from '@xmcl/task'
import { rename, unlink } from 'fs-extra'
import { join, relative } from 'path'
import { Logger } from '~/logger'
import { kDownloadOptions } from '~/network'
import { kPeerFacade } from '~/peer'
import { ResourceService, ResourceWorker } from '~/resource'
import { LauncherApp } from '../app/LauncherApp'
import { AnyError } from '../util/error'
import { linkFiles, LinkFilesTask } from './LinkFilesTask'
import { unzip } from './UnzipFileTask'
import { DownloadOptions } from '@xmcl/file-transfer'

export class InstanceFileOperationHandler {
  #downloadOptions: Array<{ download: DownloadOptions; file: string }> = []
  #resourceToUpdate: Array<{ hash: string; metadata: ResourceMetadata; uris: string[]; destination: string }> = []
  #copyOrLinkQueue: Array<{ file: InstanceFile; destination: string }> = []
  #unzipQueue: Array<{ file: InstanceFile; zipPath: string; entryName: string; destination: string }> = []
  #resourceLinkQueue: Array<{ file: InstanceFile; destination: string; resource: Resource }> = []

  /**
   * Finished file operations
   */
  readonly finished: Set<InstanceFileWithOperation> = new Set()

  constructor(private app: LauncherApp, private resourceService: ResourceService, private worker: ResourceWorker,
    private logger: Logger,
    private instancePath: string) { }

  /**
  * Get a task to handle the instance file operation
  */
  async #handleFile(file: InstanceFileWithOperation) {
    const sha1 = file.hashes.sha1
    const instancePath = this.instancePath
    const destination = join(instancePath, file.path)

    if (relative(instancePath, destination).startsWith('..')) {
      return undefined
    }

    if (file.operation === 'remove') {
      const actualSha1 = await this.worker.checksum(destination, 'sha1').catch(() => undefined)
      if (!!sha1 && actualSha1 === sha1) {
        await unlink(destination).catch(() => undefined)
      }
      // skip same file
      return
    }

    if (file.operation === 'backup-remove') {
      await rename(destination, destination + '.backup').catch(() => { })
      return
    }

    const metadata: ResourceMetadata = {}
    if (file.curseforge) {
      metadata.curseforge = {
        fileId: file.curseforge.fileId,
        projectId: file.curseforge.projectId,
      }
    }

    if (file.modrinth) {
      metadata.modrinth = {
        versionId: file.modrinth.versionId,
        projectId: file.modrinth.projectId,
      }
    }

    const isSpecialResource = file.path.startsWith(ResourceDomain.Mods) || file.path.startsWith(ResourceDomain.ResourcePacks) || file.path.startsWith(ResourceDomain.ShaderPacks)
    const pending = isSpecialResource ? `${destination}.pending` : undefined
    if (isSpecialResource) {
      const urls = file.downloads || []
      this.#resourceToUpdate.push({ destination, hash: sha1, metadata, uris: urls.filter(u => u.startsWith('http')) })
    }

    const downloadOptions = await this.#getDownloadOptions(file, destination, metadata, pending, sha1)
    if (downloadOptions) {
      this.#downloadOptions.push({ download: downloadOptions, file: file.path })
      // this.#tasks.push(downloadOptions.map((v) => {
      //   this.finished.add(file)
      //   return v
      // }))
    }

    if (file.operation === 'backup-add') {
      // backup legacy file
      await rename(destination, destination + '.backup').catch(() => undefined)
    }
  }

  /**
  * Start to process all the instance files. This is due to there are zip task which need to read all the zip entries.
  */
  async process(task: TaskRoutine<any, any>, file: InstanceFileWithOperation[]) {
    for (const f of file) {
      await this.#handleFile(f)
    }
    if (this.#copyOrLinkQueue.length > 0 || this.#resourceLinkQueue.length > 0) {
      task.update({ chunk, progress, total }, 'link', this.#unzipQueue.length)
      await linkFiles(this.#copyOrLinkQueue, this.#resourceLinkQueue, this.app.platform)
      task.update({ chunk, progress, total }, 'link', this.#unzipQueue.length)
    }
    if (this.#unzipQueue.length > 0) {
      await task.child('unzip', unzip(this.#unzipQueue, (chunk, progress, total) => {
        task.update({ chunkSizeOrStatus: chunk, progress, total }, 'unzip', this.#unzipQueue.length)
      }))
    }
  }

  async postprocess(client: ModrinthV2Client) {
    try {
      if (this.#resourceToUpdate.length > 0) {
        const options = await Promise.all(this.#resourceToUpdate.map(async ({ hash, metadata, uris, destination }) => {
          const actualSha1 = hash ?? await this.worker.checksum(destination, 'sha1').catch(() => undefined)
          return {
            hash: actualSha1,
            metadata,
            uris,
          }
        }))

        const toQuery = options.filter(r => Object.keys(r.metadata).length === 0).map(r => r.hash)
        if (toQuery.length > 0) {
          const modrinthMetadata = await client.getProjectVersionsByHash(toQuery, 'sha1')

          for (const o of options) {
            const modrinth = modrinthMetadata[o.hash]
            if (modrinth) {
              o.metadata.modrinth = {
                projectId: modrinth.project_id,
                versionId: modrinth.id,
              }
            }
          }
        }

        await this.resourceService.updateResources(options.filter(o => !!o.hash))
      }
    } catch (e) {
      this.logger.error(e as any)
    }
  }

  async #handleUnzip(file: InstanceFile, destination: string) {
    const zipUrl = file.downloads!.find(u => u.startsWith('zip:'))
    if (!zipUrl) return

    const url = new URL(zipUrl)

    if (!url.host) {
      // Zip url with absolute path
      const zipPath = decodeURI(url.pathname).substring(1)
      const entry = url.searchParams.get('entry')
      if (entry) {
        const entryName = entry
        this.#unzipQueue.push({ file, zipPath, entryName, destination })
        return true
      }
    }

    // Zip file using the sha1 resource relative apth
    const resource = await this.resourceService.getResourceByHash(url.host)
    if (resource) {
      this.#unzipQueue.push({ file, zipPath: resource.path, entryName: file.path, destination })
      return true
    }
  }

  async #getHttpDownloadOptions(file: InstanceFile, destination: string, pending?: string, sha1?: string): Promise<DownloadOptions | undefined> {
    const urls = file.downloads!.filter(u => u.startsWith('http'))
    const downloadOptions = await this.app.registry.get(kDownloadOptions)
    if (urls.length > 0) {
      // Prefer HTTP download than peer download
      return ({
        ...downloadOptions,
        url: urls,
        destination,
        pendingFile: pending,
        validator: sha1
          ? {
            hash: sha1,
            algorithm: 'sha1',
          }
          : undefined,
      })
    }
  }

  async #getPeerDownloadOptions(file: InstanceFile, destination: string, sha1?: string) {
    const peerUrl = file.downloads!.find(u => u.startsWith('peer://'))
    if (peerUrl) {
      if (this.app.registry.has(kPeerFacade)) {
        const peerService = await this.app.registry.get(kPeerFacade)
        // Use peer download if none of above existed
        return peerService.createDownloadOptions(peerUrl, destination, sha1 ?? '', file.size)
      }
    }
  }

  async #getUnzipTask() {
    return new UnzipFileTask(this.#unzipQueue)
  }

  async #handleLinkResource(file: InstanceFile, destination: string, metadata: ResourceMetadata, sha1: string) {
    if (!sha1) return

    const urls = file.downloads?.filter(u => u.startsWith('http')) || []
    const resource = await this.resourceService.getResourceByHash(sha1)

    if (resource && await this.resourceService.touchResource(resource)) {
      if (
        (metadata.modrinth && !resource.metadata.modrinth) ||
        (metadata.curseforge && resource.metadata.curseforge) ||
        (urls.length > 0 && urls.some(u => resource.uris.indexOf(u) === -1))
      ) {
        if (!resource.hash) {
          this.logger.error(new TypeError('Invalid resource ' + JSON.stringify(resource)))
        } else {
          this.#resourceToUpdate.push({ destination, hash: sha1, metadata, uris: urls })
        }
      }
      this.#resourceLinkQueue.push({ file, destination, resource })
      return true
    }
  }

  async #handleCopyOrLink(file: InstanceFile, destination: string) {
    if (file.downloads) {
      if (file.downloads[0].startsWith('file://')) {
        this.#copyOrLinkQueue.push({ file, destination })
        return true
      }
    }
  }

  async #getDownloadOptions(file: InstanceFile, destination: string, metadata: ResourceMetadata, pending: string | undefined, sha1: string) {
    if (await this.#handleCopyOrLink(file, destination)) return

    if (await this.#handleLinkResource(file, destination, metadata, sha1)) return

    if (!file.downloads) {
      throw new AnyError('DownloadFileError', 'Cannot create download file task', undefined, { file })
    }

    if (await this.#handleUnzip(file, destination)) return

    const http = await this.#getHttpDownloadOptions(file, destination, pending, sha1)
    if (http) return http

    const peer = await this.#getPeerDownloadOptions(file, destination, sha1)
    if (peer) return peer

    throw new AnyError('DownloadFileError', `Cannot resolve file! ${file.path}`)
  }
}
