import { LauncherApp } from '~/app'
import { UserService } from './UserService'
import { AnyError } from '~/util/error'

export class ModrinthOAuthClient {
  constructor(private app: LauncherApp, private userService: UserService) {
  }

  async authenticate(scopes: string[], signal?: AbortSignal) {
    const redirect_uri = `http://127.0.0.1:${await this.app.serverPort}`
    const scopesString = scopes.join(' ')
    const url = new URL('https://modrinth.com/auth/authorize')
    url.searchParams.set('client_id', 'GFz0B21y')
    url.searchParams.set('redirect_uri', redirect_uri)
    url.searchParams.set('scope', scopesString)
    this.app.shell.openInBrowser(url.toString())
    this.userService.emit('modrinth-authorize-url', url)
    const code = await new Promise<string>((resolve, reject) => {
      const abort = () => {
        reject(new AnyError('AuthCodeTimeoutError', 'Timeout to wait the auth code! Please try again later!'))
      }
      signal?.addEventListener('abort', abort)
      this.userService.once('modrinth-authorize-code', (err, code) => {
        this.app.controller.requireFocus()
        if (err) {
          reject(err)
        } else {
          resolve(code!)
        }
      })
    })
    const authUrl = new URL('https://api.xmcl.app/modrinth/auth')
    authUrl.searchParams.set('code', code)
    authUrl.searchParams.set('redirect_uri', redirect_uri)
    const response = await this.app.fetch('https://api.xmcl.app/modrinth/auth')
    if (!response.ok) {
      throw new AnyError('ModrinthAuthError', `Failed to get auth code: ${response.statusText}`)
    }
    const data = await response.json()
    this.userService.state.modrinthUser(data)
  }
}