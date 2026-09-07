; Inno Setup script for the TRAX OBS plugin.
;
; Not meant to be compiled by hand — build.ps1 stages the files and passes the
; paths in:
;
;   .\build.ps1 package
;
; which runs ISCC with /DAppVersion, /DStageDir and /DOutDir.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\dist\stage"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

#define AppName "TRAX Now Playing"
#define PluginName "trax"

[Setup]
; Keep this GUID stable forever: it is how Windows recognises an upgrade of the
; same product rather than a second copy.
AppId={{9C1E1B94-3A7E-4C0B-9A5C-7C4E2C6B1F41}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=jfarre20
VersionInfoVersion={#AppVersion}

; OBS on Windows only scans %PROGRAMDATA%\obs-studio\plugins, so the location is
; not the user's to choose.
DefaultDirName={commonappdata}\obs-studio\plugins\{#PluginName}
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
CreateAppDir=yes

; ProgramData needs elevation.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Windows locks a DLL that OBS has loaded, so let Restart Manager notice OBS and
; ask the user to close it rather than failing halfway through the copy.
CloseApplications=yes
RestartApplications=no

OutputDir={#OutDir}
OutputBaseFilename={#PluginName}-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} {#AppVersion}
UninstallFilesDir={app}\uninstall

[Files]
Source: "{#StageDir}\{#PluginName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Messages]
WelcomeLabel2=This will install [name/ver], an OBS source that shows what Windows is playing.%n%nClose OBS Studio before continuing.
FinishedLabel=[name] is installed.%n%nStart OBS Studio, then add a "TRAX Now Playing" source to a scene.

[Code]
// The uninstaller leaves the empty plugins folder behind otherwise.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Parent: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Parent := ExpandConstant('{commonappdata}\obs-studio\plugins');
    RemoveDir(Parent);
  end;
end;
