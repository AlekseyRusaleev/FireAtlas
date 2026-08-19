; Кладём WebView2Loader.dll рядом с FireAtlas.exe — без неё Windows не запускает программу.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\resources\WebView2Loader.dll"
    CopyFiles /SILENT "$INSTDIR\resources\WebView2Loader.dll" "$INSTDIR\WebView2Loader.dll"
  ${EndIf}
!macroend
