import path from 'node:path'
import { KnownFolders, norm } from '../src/main/detect/paths'

export function fakeFolders(root: string): KnownFolders {
  const home = norm(path.join(root, 'Users', 'player'))
  return {
    home,
    winAppData: home + '/AppData/Roaming',
    winLocalAppData: home + '/AppData/Local',
    winLocalAppDataLow: home + '/AppData/LocalLow',
    winDocuments: home + '/Documents',
    winPublic: norm(path.join(root, 'Users', 'Public')),
    winProgramData: norm(path.join(root, 'ProgramData')),
    winDir: norm(path.join(root, 'Windows')),
    osUserName: 'player'
  }
}
