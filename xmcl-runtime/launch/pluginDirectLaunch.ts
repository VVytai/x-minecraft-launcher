import { readFile, readdir } from 'fs-extra';
import { LauncherAppPlugin } from '~/app';
import { InstanceService } from '~/instance';
import { UserService } from '~/user';
import { LaunchService } from './LaunchService';
import { findMatchedVersion, generateLaunchOptionsWithGlobal, getAutoOrManuallJava, getAutoSelectedJava } from '@xmcl/runtime-api';
import { VersionService } from '~/version';
import { JavaService } from '~/java';
import { kSettings } from '~/settings';
import { AuthlibInjectorService } from '~/authlibInjector';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { XMCLaunch } from './XMCLaunch';

export const pluginDirectLaunch: LauncherAppPlugin = async (app) => {
  const logger = app.getLogger('DirectLaunch')
  app.on('open-file', async (file) => {
    if (!file.endsWith('.xmclaunch')) {
      return
    }
    try {
      const fileContent = await readFile(file, 'utf-8')
      const jsonContent = JSON.parse(fileContent) as XMCLaunch
      if (jsonContent.version !== 0) {
        return
      }

      const userSerivce = await app.registry.get(UserService)
      const instanceService = await app.registry.get(InstanceService)
      const versionSerivce = await app.registry.get(VersionService)
      const launchService = await app.registry.get(LaunchService)
      const javaService = await app.registry.get(JavaService)
      const authLibService = await app.registry.get(AuthlibInjectorService)

      // user
      const users = await userSerivce.getUserState()
      const userId = jsonContent.userId
      const user = users.users[userId]
      await userSerivce.refreshUser(userId)

      // instance
      const instance = instanceService.state.all[jsonContent.instancePath]
      if (!instance) {
        throw new Error('Instance not found')
      }

      // version
      await versionSerivce.initialize()
      const local = versionSerivce.state.local
      const versionHeader = findMatchedVersion(local,
        instance.version,
        instance.runtime.minecraft,
        instance.runtime.forge,
        instance.runtime.neoForged,
        instance.runtime.fabricLoader,
        instance.runtime.optifine,
        instance.runtime.quiltLoader,
        instance.runtime.labyMod)

      if (!versionHeader) {
        throw new Error('Version not found')
      }

      const resolvedVersion = await versionSerivce.resolveLocalVersion(versionHeader.id)

      // java
      const detected = getAutoSelectedJava(
        javaService.state.all,
        instance.runtime.minecraft,
        instance.runtime.forge,
        resolvedVersion,
      )
      const javaResult = await getAutoOrManuallJava(detected, (path) => javaService.resolveJava(path), instance.java)
      const java = javaResult.java || javaResult.auto.java

      // global setting
      const settings = await app.registry.get(kSettings)
      const globalAssignMemory = settings.globalAssignMemory
      const globalMinMemory = settings.globalMinMemory
      const globalMaxMemory = settings.globalMaxMemory
      const globalHideLauncher = settings.globalHideLauncher
      const globalShowLog = settings.globalShowLog
      const globalFastLaunch = settings.globalFastLaunch
      const globalDisableAuthlibInjector = settings.globalDisableAuthlibInjector
      const globalDisableElyByAuthlib = settings.globalDisableElyByAuthlib
      const globalEnv = settings.globalEnv
      const globalVmOptions = settings.globalVmOptions
      const globalMcOptions = settings.globalMcOptions
      const globalPrependCommand = settings.globalPrependCommand

      // mods
      const modCount = await readdir(join(instance.path, 'mods')).then((mods) => mods.length, () => 0)

      // launch
      const launchOptions = await generateLaunchOptionsWithGlobal(
        instance,
        user,
        versionHeader?.id,
        {
          operationId: randomUUID(),
          side: 'client',
          javaPath: java?.path,
          globalEnv,
          globalVmOptions,
          globalMcOptions,
          globalPrependCommand,
          globalAssignMemory,
          globalFastLaunch,
          globalMaxMemory,
          globalHideLauncher,
          globalDisableElyByAuthlib,
          globalDisableAuthlibInjector,
          globalShowLog,
          globalMinMemory,
          track: async (_, p) => p,
          modCount,
          getOrInstallAuthlibInjector: () => authLibService.getOrInstallAuthlibInjector(),
        }
      )

      await launchService.launch(launchOptions)
    } catch (e) {
      logger.error(e as any)
    }
  })
}