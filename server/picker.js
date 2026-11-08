/**
 * Native "choose files / choose folder" dialogs on the host PC.
 *
 * A browser never reveals real file paths, so when the person sitting at the host
 * clicks "Choose files", the server opens the operating system's own dialog instead.
 * The picked paths are then served straight from disk — no tab has to stay open.
 */
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// IFileOpenDialog gives the modern Explorer dialog for both files and folders,
// including multi-select folders (WinForms' FolderBrowserDialog is the old tree view).
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
class FerryFileOpenDialogRCW { }

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFerryShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IFerryShellItem ppsi);
  void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  void Compare(IFerryShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFerryShellItemArray {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
  void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
  void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
  void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
  void GetCount(out uint pdwNumItems);
  void GetItemAt(uint dwIndex, out IFerryShellItem ppsi);
  void EnumItems(out IntPtr ppenumShellItems);
}

[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFerryFileOpenDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  void GetFileTypeIndex(out uint piFileType);
  void Advise(IntPtr pfde, out uint pdwCookie);
  void Unadvise(uint dwCookie);
  void SetOptions(uint fos);
  void GetOptions(out uint pfos);
  void SetDefaultFolder(IFerryShellItem psi);
  void SetFolder(IFerryShellItem psi);
  void GetFolder(out IFerryShellItem ppsi);
  void GetCurrentSelection(out IFerryShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IFerryShellItem ppsi);
  void AddPlace(IFerryShellItem psi, int fdap);
  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
  void Close(int hr);
  void SetClientGuid(ref Guid guid);
  void ClearClientData();
  void SetFilter(IntPtr pFilter);
  void GetResults(out IFerryShellItemArray ppenum);
  void GetSelectedItems(out IFerryShellItemArray ppsai);
}

public static class FerryPicker {
  const uint FOS_NOCHANGEDIR = 0x8, FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40,
             FOS_ALLOWMULTISELECT = 0x200, FOS_PATHMUSTEXIST = 0x800, FOS_FILEMUSTEXIST = 0x1000;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  // Exercises the interface without showing anything (proves the vtable layout):
  // options and file name must round-trip, and GetResults before Show must fail.
  public static string Probe() {
    IFerryFileOpenDialog dlg = (IFerryFileOpenDialog)new FerryFileOpenDialogRCW();
    try {
      dlg.SetOptions(FOS_PICKFOLDERS | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM);
      uint opts; dlg.GetOptions(out opts);
      dlg.SetFileName("ferry-probe.txt");
      string name; dlg.GetFileName(out name);
      dlg.SetTitle("probe");
      dlg.SetOkButtonLabel("probe");
      int hr = 0;
      try { IFerryShellItemArray items; dlg.GetResults(out items); } catch (COMException e) { hr = e.ErrorCode; }
      bool ok = (opts & 0x260) == 0x260 && name == "ferry-probe.txt" && hr != 0;
      return ok ? "ok" : ("bad " + opts + " " + name + " " + hr);
    } finally { Marshal.ReleaseComObject(dlg); }
  }

  public static string[] Pick(IntPtr owner, bool folders, string title) {
    IFerryFileOpenDialog dlg = (IFerryFileOpenDialog)new FerryFileOpenDialogRCW();
    try {
      uint opts; dlg.GetOptions(out opts);
      opts |= FOS_NOCHANGEDIR | FOS_FORCEFILESYSTEM | FOS_ALLOWMULTISELECT | FOS_PATHMUSTEXIST;
      opts |= folders ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST;
      dlg.SetOptions(opts);
      dlg.SetTitle(title);
      dlg.SetOkButtonLabel("Share");
      int hr = dlg.Show(owner);
      if (hr == ERROR_CANCELLED) return new string[0];
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IFerryShellItemArray items; dlg.GetResults(out items);
      uint count; items.GetCount(out count);
      string[] result = new string[count];
      for (uint i = 0; i < count; i++) {
        IFerryShellItem item; items.GetItemAt(i, out item);
        string p; item.GetDisplayName(SIGDN_FILESYSPATH, out p);
        result[i] = p;
      }
      return result;
    } finally { Marshal.ReleaseComObject(dlg); }
  }
}
`;

const HASH = crypto.createHash('sha1').update(CSHARP).digest('hex').slice(0, 10);
const DLL = path.join(os.tmpdir(), `ferry-picker-${HASH}.dll`);

const PS_LOAD = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dll = $env:FERRY_DLL
if (-not ('FerryPicker' -as [type])) {
  if (-not (Test-Path -LiteralPath $dll)) {
    Add-Type -TypeDefinition $env:FERRY_CS -Language CSharp -OutputAssembly $dll -OutputType Library
  }
  if (-not ('FerryPicker' -as [type])) { Add-Type -LiteralPath $dll }
}
`;

const PS_PICK = PS_LOAD + String.raw`
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
try {
  $paths = [FerryPicker]::Pick($owner.Handle, $env:FERRY_FOLDERS -eq '1', $env:FERRY_TITLE)
  foreach ($p in $paths) { [Console]::Out.WriteLine($p) }
} finally {
  $owner.Close()
}
`;

const PS_PROBE = PS_LOAD + '\n[Console]::Out.WriteLine([FerryPicker]::Probe())\n';

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
  });
}

function powershell(script, extraEnv) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
    { env: { ...process.env, FERRY_DLL: DLL, FERRY_CS: CSHARP, ...extraEnv } },
  );
}

const lines = (out) =>
  String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const pickerSupported =
  process.platform === 'win32' || process.platform === 'darwin' || (process.platform === 'linux' && hasCommand('zenity'));

/**
 * Compile/load the Windows helper ahead of time so the first click opens instantly.
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function warmUpPicker() {
  if (process.platform !== 'win32') return { ok: pickerSupported };
  try {
    const out = lines(await powershell(PS_PROBE));
    return out[out.length - 1] === 'ok' ? { ok: true } : { ok: false, detail: out.join(' ') };
  } catch (e) {
    return { ok: false, detail: String(e.stderr || e.message).trim().split(/\r?\n/).slice(0, 6).join(' ') };
  }
}

let busy = false;

/**
 * Open the native dialog. Resolves to an array of absolute paths ([] when canceled).
 * @param {'files'|'folder'} type
 */
export async function pickPaths(type) {
  if (busy) {
    const e = new Error('A file dialog is already open on the host PC.');
    e.code = 'BUSY';
    throw e;
  }
  busy = true;
  const folders = type === 'folder';
  try {
    if (process.platform === 'win32') {
      const out = await powershell(PS_PICK, {
        FERRY_FOLDERS: folders ? '1' : '0',
        FERRY_TITLE: folders ? 'Ferry — choose folders to share' : 'Ferry — choose files to share',
      });
      return lines(out);
    }
    if (process.platform === 'darwin') {
      const pick = folders
        ? 'set picked to choose folder with prompt "Choose folders to share" with multiple selections allowed'
        : 'set picked to choose file with prompt "Choose files to share" with multiple selections allowed';
      const script = [pick, 'set out to ""', 'repeat with f in picked', 'set out to out & POSIX path of f & linefeed', 'end repeat', 'return out'];
      try {
        return lines(await run('osascript', script.flatMap((l) => ['-e', l])));
      } catch (e) {
        if (/-128/.test(e.stderr || '')) return [];
        throw e;
      }
    }
    const args = ['--file-selection', '--multiple', '--separator=\n', `--title=Ferry — choose ${folders ? 'folders' : 'files'} to share`];
    if (folders) args.push('--directory');
    try {
      return lines(await run('zenity', args));
    } catch (e) {
      if (e.code === 1) return [];
      throw e;
    }
  } finally {
    busy = false;
  }
}
