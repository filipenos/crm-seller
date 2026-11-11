import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const packageName = '@libsql/win32-x64-msvc'
const packagePath = join('node_modules', packageName)
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const version = lock.packages[`node_modules/${packageName}`]?.version
if (!version) throw new Error(`${packageName} ausente do package-lock.json`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} falhou (${result.status})`)
}

const installedPackage = join(packagePath, 'package.json')
const installedVersion = existsSync(installedPackage)
  ? JSON.parse(readFileSync(installedPackage, 'utf8')).version
  : null

if (installedVersion !== version || !existsSync(join(packagePath, 'index.node'))) {
  const temporary = mkdtempSync(join(tmpdir(), 'crm-win-libsql-'))
  try {
    run('npm', ['pack', `${packageName}@${version}`, '--pack-destination', temporary, '--silent'])
    const archive = join(temporary, `libsql-win32-x64-msvc-${version}.tgz`)
    rmSync(packagePath, { recursive: true, force: true })
    run('mkdir', ['-p', packagePath])
    run('tar', ['-xzf', archive, '-C', packagePath, '--strip-components=1'])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', 'dir', '--publish', 'never'])

const unpacked = join('dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', packageName, 'index.node')
if (!existsSync(unpacked)) throw new Error(`Build Windows sem ${packageName}`)
const asar = spawnSync('node', ['node_modules/@electron/asar/bin/asar.js', 'list', 'dist/win-unpacked/resources/app.asar'], { encoding: 'utf8' })
if (asar.error) throw asar.error
if (asar.status !== 0 || !asar.stdout.includes(`/node_modules/${packageName}/package.json`)) {
  throw new Error(`app.asar sem ${packageName}`)
}
console.log('Prévia Windows pronta com o módulo nativo do libSQL.')
