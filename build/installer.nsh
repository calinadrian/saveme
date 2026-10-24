; Uninstalling also removes "Start with Windows". Electron registers it under the AppUserModelId.
; Updates run the old uninstaller too, so leave the entry alone for them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.saveme.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "app.saveme.desktop"
  ${endIf}
!macroend
