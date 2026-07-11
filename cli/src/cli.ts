import { Command } from 'commander'
import { registerInit, registerLogin } from './commands/init.js'
import { registerPush } from './commands/push.js'
import { registerList, registerInbox } from './commands/list.js'
import { registerGet } from './commands/get.js'
import { registerApprove, registerReject } from './commands/approve.js'
import { registerTail } from './commands/tail.js'
import { registerPresets, registerWatchAdd } from './commands/presets.js'
import { registerWatchers } from './commands/watchers.js'
import { registerKeys } from './commands/keys.js'
import { registerStatus } from './commands/status.js'

const program = new Command()

program
  .name('impri')
  .description('Human-in-the-loop approval for AI agents')
  .version('0.1.0')

registerInit(program)
registerLogin(program)
registerPush(program)
registerList(program)
registerInbox(program)
registerGet(program)
registerApprove(program)
registerReject(program)
registerTail(program)
registerPresets(program)
registerWatchers(program)
registerKeys(program)
registerStatus(program)

// 'impri watch add' — alias to the preset-based add under a 'watch' command
const watchCmd = program.command('watch').description("Manage watchers (alias; see also 'impri watchers')")
registerWatchAdd(watchCmd)

program.parse(process.argv)
