; Instalador de HomeTV para Windows (Inno Setup). Lo compila GitHub Actions: ISCC /DVersion=2.8.3 windows\instalador.iss
; Se instala por usuario (sin pedir permisos de administrador) para que el programa pueda actualizarse solo.
#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
AppId={{6B1F4C2E-7A53-4E0B-9C1D-48A0F5D2E7B1}
AppName=HomeTV
AppVersion={#Version}
AppPublisher=HomeTV
DefaultDirName={autopf}\HomeTV
DefaultGroupName=HomeTV
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\salida
OutputBaseFilename=HomeTV-Instalador
SetupIconFile=hometv.ico
UninstallDisplayIcon={app}\HomeTV.exe
UninstallDisplayName=HomeTV
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "escritorio"; Description: "Crear un icono en el escritorio"; GroupDescription: "Accesos directos:"
Name: "inicio"; Description: "Abrir HomeTV al encender el ordenador"; GroupDescription: "Otros:"; Flags: unchecked

[Files]
Source: "..\salida\HomeTV\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\HomeTV"; Filename: "{app}\HomeTV.exe"
Name: "{autodesktop}\HomeTV"; Filename: "{app}\HomeTV.exe"; Tasks: escritorio
Name: "{userstartup}\HomeTV"; Filename: "{app}\HomeTV.exe"; Tasks: inicio

[Run]
Filename: "{app}\HomeTV.exe"; Description: "Abrir HomeTV ahora"; Flags: nowait postinstall skipifsilent
