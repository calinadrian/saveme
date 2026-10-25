import fs from 'node:fs'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import yazl from 'yazl'
import { AppState, DiagnosticsReport } from '../shared/types'

/** Only fixed classifications cross this boundary; arbitrary error text is never exported. */
function classification(message: string): string {
  if (/ENOSPC|not enough.*space|disk.*full/i.test(message)) return 'insufficient-disk-space'
  if (/401|403|sign.in|token|permission|EACCES|EPERM/i.test(message)) return 'access-or-authentication'
  if (/timeout|timed out|offline|unavailable|network|ECONN|fetch/i.test(message)) return 'storage-unavailable'
  if (/integrity|corrupt|invalid|incomplete|unsafe|duplicate/i.test(message)) return 'validation-failed'
  if (/rollback|recovery|interrupted restore/i.test(message)) return 'recovery'
  if (/changing|running|quiet|busy/i.test(message)) return 'files-busy'
  return 'operation-event'
}

export function diagnostics(state: AppState, versions: Record<string, string>): DiagnosticsReport {
  const runtime: Record<string,string> = {}
  for (const key of ['saveme','electron','node','chrome','platform','arch']) if (versions[key]) runtime[key] = versions[key]
  const kinds = ['backup','restore','skip','error','info']
  return {
    format: 1, generatedAt: new Date().toISOString(), runtime,
    storage: { kind: state.provider.kind, connected: state.provider.connected, usageStatus: state.backupUsage?.status ?? 'unavailable', totalBytes: state.quota?.totalBytes, usedBytes: state.quota?.usedBytes },
    health: { games: state.games.length, tracked: state.games.filter(g => g.tracked).length, queued: state.queue.length, recoveryRequired: !!state.recoveryWarning, operation: state.operation?.kind, failedGames: state.games.filter(g => g.status === 'error').length },
    recentEvents: state.activity.slice(0,200).map(e => ({ at: Number.isFinite(Date.parse(e.at)) ? new Date(e.at).toISOString() : 'unknown', kind: kinds.includes(e.kind) ? e.kind : 'info', code: classification(e.message) }))
  }
}

export async function saveDiagnostics(file: string, report: DiagnosticsReport): Promise<void> {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  try {
    const zip = new yazl.ZipFile()
    zip.on('error', error => (zip.outputStream as Readable).destroy(error))
    const writing = pipeline(zip.outputStream,fs.createWriteStream(temporary,{ flags: 'wx' }))
    const json = JSON.stringify(report,null,2)
    zip.addBuffer(Buffer.from(json),'report.json')
    zip.addBuffer(Buffer.from('SaveMe diagnostic report\n\nPersonal paths, account details, credentials, save contents, and raw error messages are excluded.\n\n' + json),'report.txt')
    zip.end(); await writing
    await fs.promises.rename(temporary,file)
  } finally { await fs.promises.rm(temporary,{ force: true }) }
}
