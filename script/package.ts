/* eslint-disable no-sync */

import * as cp from 'child_process'
import * as path from 'path'
import * as electronInstaller from 'electron-winstaller'
import { getProductName, getCompanyName } from '../app/package-info'
import {
  getDistPath,
  getOSXZipPath,
  getWindowsIdentifierName,
  getWindowsStandaloneName,
  getWindowsInstallerName,
  shouldMakeDelta,
  getUpdatesURL,
  isPublishable,
  getBundleSizes,
  getDistRoot,
  getDistArchitecture,
  getIconDirectory,
} from './dist-info'
import { isGitHubActions } from './build-platforms'
import {
  getSignWithParams,
  getSigningThumbprint,
  signWindowsFile,
  verifyWindowsSignature,
} from './windows-sign'
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { getVersion } from '../app/package-info'
import { rename } from 'fs/promises'
import { join } from 'path'
import { assertNonNullable } from '../app/src/lib/fatal-error'

const distPath = getDistPath()
const productName = getProductName()
const outputDir = getDistRoot()

const assertExistsSync = (path: string) => {
  if (!existsSync(path)) {
    throw new Error(`Expected ${path} to exist`)
  }
}

if (process.platform === 'darwin') {
  packageOSX()
} else if (process.platform === 'win32') {
  packageWindows()
} else {
  console.error(`I don't know how to package for ${process.platform} :(`)
  process.exit(1)
}

console.log('Writing bundle size info…')
writeFileSync(
  path.join(getDistRoot(), 'bundle-size.json'),
  JSON.stringify(getBundleSizes())
)

function packageOSX() {
  const dest = getOSXZipPath()
  rmSync(dest, { recursive: true, force: true })

  console.log('Packaging for macOS…')
  cp.execSync(
    `ditto -ck --keepParent "${distPath}/${productName}.app" "${dest}"`
  )
}

function packageWindows() {
  const iconSource = join(getIconDirectory(), 'icon-logo.ico')

  if (!existsSync(iconSource)) {
    console.error(`expected setup icon not found at location: ${iconSource}`)
    process.exit(1)
  }

  // Drop the bundled updater.exe (built by `yarn build:updater`) into the
  // packaged app folder so it ships alongside GitHubDesktop.exe and is
  // available at runtime for self-updating.
  const updaterSource = join(getDistRoot(), 'updater.exe')
  if (!existsSync(updaterSource)) {
    console.error(
      `expected updater.exe at ${updaterSource}. Run \`yarn build:updater\` before packaging.`
    )
    process.exit(1)
  }
  // Signed here rather than where it's built, because `pkg` writes a fresh
  // executable every time and a signature applied earlier wouldn't survive it.
  // Both copies get signed: the one in the packaged folder is what ships, and
  // the one in dist is what a portable zip is made from.
  signWindowsFile(updaterSource)
  copyFileSync(updaterSource, join(distPath, 'updater.exe'))

  const splashScreenPath = path.resolve(
    __dirname,
    '../app/static/logos/win32-installer-splash.gif'
  )

  if (!existsSync(splashScreenPath)) {
    console.error(
      `expected setup splash screen gif not found at location: ${splashScreenPath}`
    )
    process.exit(1)
  }

  const iconUrl = 'https://desktop.githubusercontent.com/app-icon.ico'

  const nugetPkgName = getWindowsIdentifierName()
  const options: electronInstaller.Options = {
    name: nugetPkgName,
    appDirectory: distPath,
    outputDirectory: outputDir,
    authors: getCompanyName(),
    iconUrl: iconUrl,
    setupIcon: iconSource,
    loadingGif: splashScreenPath,
    exe: `${nugetPkgName}.exe`,
    title: productName,
    setupExe: getWindowsStandaloneName(),
    setupMsi: getWindowsInstallerName(),
  }

  // electron-winstaller's nuspec template only includes a hard-coded whitelist
  // (*.dll, *.bin, *.pak, etc.) — updater.exe doesn't match any pattern and
  // gets silently dropped from the installer. Pass it explicitly via
  // additionalFiles so it ends up next to D3SKTOP.exe. The `@types/electron-
  // winstaller` definitions are outdated and don't expose this option, so cast.
  ;(
    options as electronInstaller.Options & { additionalFiles: unknown }
  ).additionalFiles = [
    { src: 'updater.exe', target: 'lib\\net45\\updater.exe' },
  ]

  if (shouldMakeDelta()) {
    const url = new URL(getUpdatesURL())
    // Make sure Squirrel.Windows isn't affected by partially or completely
    // disabled releases.
    url.searchParams.set('bypassStaggeredRelease', '1')
    options.remoteReleases = url.toString()
  }

  // Signing the installer, and Squirrel's Update.exe along with it.
  //
  // Upstream signs through GitHub Inc's own Azure Code Signing account, which
  // came with the fork and can't be used from here — so that path stays behind
  // its GitHub Actions gate, and a thumbprint in the environment takes
  // precedence when there is one. See docs/technical/code-signing.md.
  const signingThumbprint = getSigningThumbprint()

  if (signingThumbprint !== undefined) {
    options.signWithParams = getSignWithParams(signingThumbprint)
  } else if (isGitHubActions() && isPublishable()) {
    assertNonNullable(process.env.RUNNER_TEMP, 'Missing RUNNER_TEMP env var')

    const acsPath = join(process.env.RUNNER_TEMP, 'acs')
    const dlibPath = join(acsPath, 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll')

    assertExistsSync(dlibPath)

    const metadataPath = join(acsPath, 'metadata.json')
    const acsMetadata = {
      Endpoint: 'https://wus3.codesigning.azure.net/',
      CodeSigningAccountName: 'GitHubInc',
      CertificateProfileName: 'GitHubInc',
      CorrelationId: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    }
    writeFileSync(metadataPath, JSON.stringify(acsMetadata))

    options.signWithParams = `/v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib "${dlibPath}" /dmdf "${metadataPath}"`
  }

  console.log('Packaging for Windows…')
  electronInstaller
    .createWindowsInstaller(options)
    .then(() => console.log(`Installers created in ${outputDir}`))
    .then(() => {
      // Squirrel signs the setup exe on its way past, but not the msi it writes
      // alongside it, so that one is done here. Both are then verified: a build
      // that has quietly produced an unsigned installer should stop rather than
      // hand over something nobody will check.
      // Note the names read backwards: `getWindowsInstallerName` is the msi and
      // `getWindowsStandaloneName` is the setup exe.
      const msiPath = join(outputDir, getWindowsInstallerName())

      if (existsSync(msiPath)) {
        signWindowsFile(msiPath)
        verifyWindowsSignature(msiPath)
      }

      const setupPath = join(outputDir, getWindowsStandaloneName())

      if (existsSync(setupPath)) {
        verifyWindowsSignature(setupPath)
      }
    })
    .then(async () => {
      // electron-winstaller (more specifically Squirrel.Windows) doesn't let
      // us control the name of the nuget packages but we want them to include
      // the architecture similar to how the setup exe and msi do so we'll just
      // have to rename them here after the fact.
      const arch = getDistArchitecture()
      const prefix = `${getWindowsIdentifierName()}-${getVersion()}`

      for (const kind of shouldMakeDelta() ? ['full', 'delta'] : ['full']) {
        const from = join(outputDir, `${prefix}-${kind}.nupkg`)
        const to = join(outputDir, `${prefix}-${arch}-${kind}.nupkg`)

        // Squirrel writes a delta only when it managed to download a previous
        // release to diff against, so `shouldMakeDelta()` states intent rather
        // than outcome. Renaming unconditionally meant one absent package
        // rejected this whole chain and the portable zip below never got made —
        // with the installers already sitting on disk, looking like a total
        // failure when almost everything had succeeded.
        if (!existsSync(from)) {
          console.log(`No ${kind} package was produced; nothing to rename.`)
          continue
        }

        console.log(`Renaming ${from} to ${to}`)
        await rename(from, to)
      }
    })
    .then(() => {
      /*
       * Emit a portable zip of the packaged app folder so the fork's custom
       * updater has something to download from GitHub Releases. The tar.exe
       * built into Windows 10+ is bsdtar, which handles .zip with `-a -cf`.
       *
       * Named by its full path rather than left to PATH. Git for Windows ships
       * GNU tar in its own bin directory, and a build started from Git Bash
       * finds that one first — it reads `C:\…` as a host to connect to and
       * fails with "Cannot connect to C: resolve failed" after everything else
       * has already been built and signed.
       */
      const arch = getDistArchitecture()
      const zipName = `${getWindowsIdentifierName()}-win32-${arch}.zip`
      const zipPath = join(outputDir, zipName)
      if (existsSync(zipPath)) {
        rmSync(zipPath)
      }
      console.log(`Creating portable zip ${zipName}…`)
      const systemTar = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'system32',
        'tar.exe'
      )

      cp.execFileSync(
        existsSync(systemTar) ? systemTar : 'tar.exe',
        ['-a', '-cf', zipPath, '-C', distPath, '.'],
        { stdio: 'inherit' }
      )
    })
    .catch(e => {
      console.error(`Error packaging: ${e}`)
      process.exit(1)
    })
}
