; Inno Setup script — OBS Lower Thirds native plugin
; Installs into the OBS Studio program folder (the location Windows OBS
; actually scans for plugins) and registers the control-panel dock.

#define MyAppName "OBS Lower Thirds"
#define MyAppVersion "1.3.0"

[Setup]
AppId={{7E1FA9D2-52B4-4A0C-9D8E-2C6A31B0F5D7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=lowerthird
DefaultDirName={code:GetObsDir}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=..\dist
OutputBaseFilename=obs-lowerthirds-setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#MyAppName} (OBS plugin)
CreateUninstallRegKey=yes
UninstallFilesDir={app}\data\obs-plugins\obs-lowerthirds
WizardStyle=modern

[Files]
Source: "..\dist\obs-lowerthirds\bin\64bit\obs-lowerthirds.dll"; DestDir: "{app}\obs-plugins\64bit"; Flags: ignoreversion
Source: "..\dist\obs-lowerthirds\data\*"; DestDir: "{app}\data\obs-plugins\obs-lowerthirds"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "install-dock.ps1"; DestDir: "{app}\data\obs-plugins\obs-lowerthirds"; Flags: ignoreversion

[Run]
; runasoriginaluser: the dock entry lives in the *user's* obs-studio\user.ini
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\data\obs-plugins\obs-lowerthirds\install-dock.ps1"""; Flags: runhidden runasoriginaluser; StatusMsg: "Registering the Lower Thirds dock in OBS..."

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\data\obs-plugins\obs-lowerthirds\install-dock.ps1"" -Remove"; Flags: runhidden; RunOnceId: "RemoveLtDock"

[Code]
function GetObsDir(Param: String): String;
var
  Dir: String;
begin
  Result := ExpandConstant('{autopf}') + '\obs-studio';
  if RegQueryStringValue(HKLM, 'SOFTWARE\OBS Studio', '', Dir) and (Dir <> '') then
    Result := Dir
  else if RegQueryStringValue(HKLM32, 'SOFTWARE\OBS Studio', '', Dir) and (Dir <> '') then
    Result := Dir;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not FileExists(GetObsDir('') + '\bin\64bit\obs64.exe') then begin
    MsgBox('OBS Studio was not found on this computer. Install OBS Studio first, then run this installer again.', mbError, MB_OK);
    Result := False;
  end;
end;

function ObsRunning(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq obs64.exe" | find /I "obs64.exe" >nul', '',
          SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not WizardSilent) then begin
    if ObsRunning() then
      MsgBox('OBS is currently running.' + #13#10 + #13#10 +
             'Restart OBS to load the Lower Thirds plugin. If the dock is missing after the restart, run this installer again with OBS closed.',
             mbInformation, MB_OK)
    else
      MsgBox('Installed. Start OBS - the plugin loads automatically:' + #13#10 +
             '- control panel: View > Docks > Lower Thirds (or Tools > Lower Thirds Panel)' + #13#10 +
             '- add a "Lower Third" source to your scenes',
             mbInformation, MB_OK);
  end;
end;
