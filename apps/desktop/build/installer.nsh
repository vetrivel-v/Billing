; Extra installer steps for CommerceBill (included by electron-builder's NSIS template).
;
; Uninstalling removes the PROGRAM only. The business data lives in %LOCALAPPDATA%\CommerceBill, outside the program folder, and is never
; deleted by the uninstaller (deleteAppDataOnUninstall is off). This message says so, in plain words, when the uninstall is interactive.

!macro customUnInstall
  ${ifNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION "CommerceBill was removed.$\r$\n$\r$\nYour business data was NOT deleted. It is kept in:$\r$\n$LOCALAPPDATA\CommerceBill$\r$\n$\r$\nInstalling CommerceBill again will find it. To delete it for good, close CommerceBill and delete that folder yourself (see the installation guide)."
  ${endIf}
!macroend
