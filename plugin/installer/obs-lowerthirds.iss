; Inno Setup script — OBS Lower Thirds native plugin
; Installs into the OBS Studio program folder (the location Windows OBS
; actually scans for plugins) and registers the control-panel dock.
;
; Two builds from this one script:
;   ISCC obs-lowerthirds.iss                 -> obs-lowerthirds-setup.exe   (install, or update)
;   ISCC /DUPDATE_ONLY obs-lowerthirds.iss   -> obs-lowerthirds-update.exe  (update an existing install)
; Both update IN PLACE: same AppId, files overwritten, nothing uninstalled;
; presets, saved texts and uploads live in %APPDATA% and are never touched.
; OBS may keep running: the loaded DLL is renamed aside (it cannot be
; overwritten while mapped, but it can be renamed) and the new one is put in
; its place for the next OBS start; the dock and overlay files are live at
; once. The plugin sweeps the parked copies the next time it loads.

#define MyAppName "OBS Lower Thirds"
#define MyAppVersion "1.6.20"
#define UninstKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\{7E1FA9D2-52B4-4A0C-9D8E-2C6A31B0F5D7}_is1"

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
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#MyAppName} (OBS plugin)
CreateUninstallRegKey=yes
UninstallFilesDir={app}\data\obs-plugins\obs-lowerthirds
WizardStyle=modern
#ifdef UPDATE_ONLY
OutputBaseFilename=obs-lowerthirds-update
AppVerName={#MyAppName} {#MyAppVersion} update
DisableReadyPage=yes
DisableFinishedPage=yes
#else
OutputBaseFilename=obs-lowerthirds-setup
#endif

[Files]
Source: "..\dist\obs-lowerthirds\bin\64bit\obs-lowerthirds.dll"; DestDir: "{app}\obs-plugins\64bit"; Flags: ignoreversion
Source: "..\dist\obs-lowerthirds\data\*"; DestDir: "{app}\data\obs-plugins\obs-lowerthirds"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "install-dock.ps1"; DestDir: "{app}\data\obs-plugins\obs-lowerthirds"; Flags: ignoreversion

[Run]
; runasoriginaluser: the dock entry lives in the *user's* obs-studio\user.ini.
; The script skips itself while OBS is running and is idempotent otherwise.
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

{ the version already installed, '' when none }
function InstalledVersion(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKLM, '{#UninstKey}', 'DisplayVersion', Result) then
    if not RegQueryStringValue(HKLM64, '{#UninstKey}', 'DisplayVersion', Result) then
      Result := '';
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not FileExists(GetObsDir('') + '\bin\64bit\obs64.exe') then begin
    MsgBox('OBS Studio was not found on this computer. Install OBS Studio first, then run this installer again.', mbError, MB_OK);
    Result := False;
    exit;
  end;
#ifdef UPDATE_ONLY
  if InstalledVersion() = '' then begin
    MsgBox('This is the update package, and OBS Lower Thirds is not installed on this computer yet.' + #13#10 +
           'Run obs-lowerthirds-setup.exe first.', mbError, MB_OK);
    Result := False;
  end;
#endif
end;

procedure InitializeWizard();
var
  Prev: String;
begin
  Prev := InstalledVersion();
  if Prev <> '' then
    WizardForm.WelcomeLabel2.Caption :=
      'This updates OBS Lower Thirds ' + Prev + ' to {#MyAppVersion} in place.' + #13#10 + #13#10 +
      'Nothing is removed: your presets, saved texts, uploads and the dock stay exactly as they are.' + #13#10 + #13#10 +
      'OBS may keep running. The control panel and overlay files are updated at once; the plugin itself loads the next time OBS starts.';
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

{ A DLL that OBS has loaded cannot be overwritten, but it can be renamed.
  Park it under a unique name so the new one can take its place; the plugin
  sweeps parked copies when it next loads. Earlier parked copies that are no
  longer mapped are swept here as well. }
procedure ParkLoadedDll();
var
  Dir, Dll, Parked: String;
  FindRec: TFindRec;
begin
  Dir := ExpandConstant('{app}') + '\obs-plugins\64bit';
  Dll := Dir + '\obs-lowerthirds.dll';
  if FindFirst(Dir + '\obs-lowerthirds.dll.old*', FindRec) then begin
    try
      repeat
        DeleteFile(Dir + '\' + FindRec.Name);
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  if FileExists(Dll) then begin
    Parked := Dll + '.old-' + GetDateTimeString('yyyymmdd-hhnnss', #0, #0);
    if RenameFile(Dll, Parked) then
      Log('parked the loaded plugin DLL as ' + Parked)
    else
      Log('could not park the loaded plugin DLL: ' + Dll);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Prev: String;
begin
  if (CurStep = ssInstall) and ObsRunning() then
    ParkLoadedDll();

  if (CurStep = ssPostInstall) and (not WizardSilent) then begin
    Prev := InstalledVersion();
    if ObsRunning() then
      MsgBox('{#MyAppName} {#MyAppVersion} is installed.' + #13#10 + #13#10 +
             'OBS is running: the control panel and overlay files are already the new ones; the plugin itself loads the next time OBS starts. ' +
             'Restart OBS whenever convenient.',
             mbInformation, MB_OK)
    else
      MsgBox('{#MyAppName} {#MyAppVersion} is installed. Start OBS - the plugin loads automatically:' + #13#10 +
             '- control panel: View > Docks > Lower Thirds (or Tools > Lower Thirds Panel)' + #13#10 +
             '- add a "Lower Third" source to your scenes',
             mbInformation, MB_OK);
  end;
end;
