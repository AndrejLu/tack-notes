const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)
  const iconPath = path.join(__dirname, 'icon.ico')
  const rcedit = path.join(
    os.homedir(),
    'AppData/Local/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/rcedit-x64.exe'
  )

  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack] exe not found:', exePath)
    return
  }
  if (!fs.existsSync(rcedit)) {
    console.warn('[afterPack] rcedit not found:', rcedit)
    return
  }

  const args = [exePath]
  if (fs.existsSync(iconPath)) {
    args.push('--set-icon', iconPath)
  }
  args.push(
    '--set-version-string',
    'FileDescription',
    'Tack Notes',
    '--set-version-string',
    'ProductName',
    'Tack Notes',
    '--set-version-string',
    'InternalName',
    'TackNotes',
    '--set-version-string',
    'OriginalFilename',
    'Tack Notes.exe',
    '--set-version-string',
    'CompanyName',
    'Tack Notes'
  )

  execFileSync(rcedit, args, { stdio: 'inherit' })
  console.log('[afterPack] embedded icon + metadata into', exeName)
}
