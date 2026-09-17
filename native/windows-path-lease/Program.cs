using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string name, uint access, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);

    private sealed class Lease : IDisposable
    {
        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public void Add(SafeFileHandle handle) { handles.Add(handle); }
        public void Dispose()
        {
            for (int i = handles.Count - 1; i >= 0; --i) handles[i].Dispose();
            handles.Clear();
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if (args.Length == 1 && args[0] == "system-roots") return PrintSystemRoots();
            if (args.Length != 4 || args[0] != "lease")
                throw new InvalidOperationException("usage: operator-windows-path-lease lease <existing|parent> <root> <target>");
            string mode = args[1];
            if (mode != "existing" && mode != "parent") throw new InvalidOperationException("invalid lease mode");

            using (Lease lease = Acquire(args[2], args[3], mode == "existing"))
            {
                Console.Out.WriteLine("READY");
                Console.Out.Flush();
                Console.In.ReadToEnd();
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[operator-path-lease] " + ex.Message);
            return 1;
        }
    }

    private static Lease Acquire(string rootInput, string targetInput, bool includeTarget)
    {
        string root = Normalize(rootInput);
        string target = Normalize(targetInput);
        if (!Inside(target, root)) throw new InvalidOperationException("target escapes authorized root");
        string relative = target.Length == root.Length ? "" : target.Substring(root.Length).TrimStart('\\');
        string[] parts = relative.Length == 0 ? new string[0] : relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        int count = includeTarget ? parts.Length : Math.Max(parts.Length - 1, 0);
        Lease lease = new Lease();
        try
        {
            OpenChecked(root, true, lease);
            string current = root;
            for (int i = 0; i < count; ++i)
            {
                current = Path.Combine(current, parts[i]);
                bool mustBeDirectory = !includeTarget || i < count - 1;
                OpenChecked(current, mustBeDirectory, lease);
            }
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }

    private static void OpenChecked(string name, bool requireDirectory, Lease lease)
    {
        SafeFileHandle handle = CreateFile(
            name, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException("cannot lease path component (Win32 " + error + "): " + name);
        }
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info))
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException("cannot inspect leased path component (Win32 " + error + ")");
        }
        if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            handle.Dispose();
            throw new IOException("reparse point denied: " + name);
        }
        if (requireDirectory && (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
        {
            handle.Dispose();
            throw new IOException("non-directory path component denied: " + name);
        }
        lease.Add(handle);
    }

    private static string Normalize(string input)
    {
        if (String.IsNullOrWhiteSpace(input)) throw new InvalidOperationException("path is empty");
        string full = Path.GetFullPath(input);
        string root = Path.GetPathRoot(full);
        if (full.Length > root.Length) full = full.TrimEnd('\\');
        return full;
    }

    private static bool Inside(string target, string root)
    {
        if (String.Equals(target, root, StringComparison.OrdinalIgnoreCase)) return true;
        string prefix = root.EndsWith("\\", StringComparison.Ordinal) ? root : root + "\\";
        return target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static int PrintSystemRoots()
    {
        Console.Out.WriteLine("WINDOWS=" + TrustedFolder(Environment.SpecialFolder.Windows, "Windows"));
        Console.Out.WriteLine("SYSTEM=" + TrustedFolder(Environment.SpecialFolder.System, "System"));
        Console.Out.WriteLine("PROGRAMFILES=" + TrustedFolder(Environment.SpecialFolder.ProgramFiles, "ProgramFiles"));
        Console.Out.WriteLine("PROGRAMFILES_X86=" + TrustedFolder(Environment.SpecialFolder.ProgramFilesX86, "ProgramFilesX86"));
        Console.Out.WriteLine("USERPROFILE=" + TrustedFolder(Environment.SpecialFolder.UserProfile, "UserProfile"));
        Console.Out.WriteLine("LOCALAPPDATA=" + TrustedFolder(Environment.SpecialFolder.LocalApplicationData, "LocalApplicationData"));
        Console.Out.WriteLine("APPDATA=" + TrustedFolder(Environment.SpecialFolder.ApplicationData, "ApplicationData"));
        Console.Out.WriteLine("PROGRAMDATA=" + TrustedFolder(Environment.SpecialFolder.CommonApplicationData, "CommonApplicationData"));
        return 0;
    }

    private static string TrustedFolder(Environment.SpecialFolder folder, string label)
    {
        string value = Environment.GetFolderPath(folder);
        if (String.IsNullOrWhiteSpace(value)) throw new InvalidOperationException(label + " known folder is unavailable");
        string full = Path.GetFullPath(value);
        if (full.Length > Path.GetPathRoot(full).Length) full = full.TrimEnd('\\');
        if (!Path.IsPathRooted(full) || !Directory.Exists(full)) throw new InvalidOperationException(label + " known folder is invalid");
        if (full.IndexOfAny(new[] { '\r', '\n', '\0', ';' }) >= 0) throw new InvalidOperationException(label + " known folder contains unsafe characters");
        return full;
    }

    private static int SelfTest()
    {
        string baseDir = Path.Combine(Path.GetTempPath(), "operator-path-lease-" + Guid.NewGuid().ToString("N"));
        string root = Path.Combine(baseDir, "root");
        string child = Path.Combine(root, "child");
        Directory.CreateDirectory(child);
        try
        {
            using (Lease lease = Acquire(root, child, true)) { }
            TrustedFolder(Environment.SpecialFolder.Windows, "Windows");
            TrustedFolder(Environment.SpecialFolder.System, "System");
            TrustedFolder(Environment.SpecialFolder.ProgramFiles, "ProgramFiles");
            TrustedFolder(Environment.SpecialFolder.ProgramFilesX86, "ProgramFilesX86");
            TrustedFolder(Environment.SpecialFolder.UserProfile, "UserProfile");
            TrustedFolder(Environment.SpecialFolder.LocalApplicationData, "LocalApplicationData");
            Console.Out.WriteLine("operator-path-lease-self-test:ok");
            return 0;
        }
        finally { Directory.Delete(baseDir, true); }
    }
}
