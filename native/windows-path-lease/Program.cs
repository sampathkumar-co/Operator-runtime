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
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process, out System.Runtime.InteropServices.ComTypes.FILETIME creationTime,
        out System.Runtime.InteropServices.ComTypes.FILETIME exitTime,
        out System.Runtime.InteropServices.ComTypes.FILETIME kernelTime,
        out System.Runtime.InteropServices.ComTypes.FILETIME userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

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
            if (args.Length == 2 && args[0] == "process-instance") return PrintProcessInstance(args[1]);
            if (args.Length == 3 && args[0] == "terminate-tree") return TerminateOwnedProcessTree(args[1], args[2]);
            if (args.Length != 4 || args[0] != "lease")
                throw new InvalidOperationException("usage: operator-windows-path-lease <lease <existing|parent> <root> <target>|system-roots|process-instance <pid>|terminate-tree <pid> <creation-filetime>>");
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

    private static int TerminateOwnedProcessTree(string pidInput, string creationInput)
    {
        uint rootPid;
        ulong expectedCreation;
        if (!UInt32.TryParse(pidInput, out rootPid) || rootPid < 1)
            throw new InvalidOperationException("invalid process id");
        if (!UInt64.TryParse(creationInput, out expectedCreation) || expectedCreation == 0)
            throw new InvalidOperationException("invalid process creation identity");

        uint access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE;
        IntPtr root = OpenProcess(access, false, rootPid);
        if (root == IntPtr.Zero)
            throw new InvalidOperationException("cannot open owned root process (Win32 " + Marshal.GetLastWin32Error() + ")");
        IntPtr job = IntPtr.Zero;
        try
        {
            if (ProcessCreationFiletime(root) != expectedCreation)
                throw new InvalidOperationException("owned root process identity changed");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new InvalidOperationException("cannot create process containment job (Win32 " + Marshal.GetLastWin32Error() + ")");
            AssignExactHandleToJob(job, root, rootPid);

            HashSet<uint> assigned = new HashSet<uint>();
            assigned.Add(rootPid);
            int stableRounds = 0;
            for (int round = 0; round < 16 && stableRounds < 2; ++round)
            {
                Dictionary<uint, uint> parents = SnapshotProcessParents();
                HashSet<uint> descendants = DescendantPids(rootPid, parents);
                int newlyObserved = 0;
                foreach (uint pid in descendants)
                {
                    if (assigned.Contains(pid)) continue;
                    IntPtr process = OpenProcess(access, false, pid);
                    if (process == IntPtr.Zero)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 87 || error == 1168) continue;
                        throw new InvalidOperationException("cannot open owned descendant process " + pid + " (Win32 " + error + ")");
                    }
                    try
                    {
                        AssignExactHandleToJob(job, process, pid);
                        assigned.Add(pid);
                        newlyObserved++;
                    }
                    finally { CloseHandle(process); }
                }
                if (newlyObserved == 0) stableRounds++;
                else stableRounds = 0;
                if (stableRounds < 2) System.Threading.Thread.Sleep(10);
            }

            if (!TerminateJobObject(job, 1))
                throw new InvalidOperationException("cannot terminate owned process containment job (Win32 " + Marshal.GetLastWin32Error() + ")");
            uint wait = WaitForSingleObject(root, 5000);
            if (wait == WAIT_TIMEOUT)
                throw new InvalidOperationException("owned root process remained after process containment termination");
            if (wait != WAIT_OBJECT_0)
                throw new InvalidOperationException("cannot prove owned root process termination (Win32 " + Marshal.GetLastWin32Error() + ")");
            Console.Out.WriteLine("TERMINATED");
            return 0;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            CloseHandle(root);
        }
    }

    private static void AssignExactHandleToJob(IntPtr job, IntPtr process, uint pid)
    {
        bool already;
        if (!IsProcessInJob(process, job, out already))
            throw new InvalidOperationException("cannot inspect process containment for " + pid + " (Win32 " + Marshal.GetLastWin32Error() + ")");
        if (already) return;
        if (!AssignProcessToJobObject(job, process))
            throw new InvalidOperationException("cannot contain owned process " + pid + " (Win32 " + Marshal.GetLastWin32Error() + ")");
    }

    private static Dictionary<uint, uint> SnapshotProcessParents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new InvalidOperationException("cannot snapshot process tree (Win32 " + Marshal.GetLastWin32Error() + ")");
        try
        {
            Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry))
                throw new InvalidOperationException("cannot enumerate process tree (Win32 " + Marshal.GetLastWin32Error() + ")");
            do
            {
                if (entry.th32ProcessID != 0) parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32Next(snapshot, ref entry));
            return parents;
        }
        finally { CloseHandle(snapshot); }
    }

    private static HashSet<uint> DescendantPids(uint rootPid, Dictionary<uint, uint> parents)
    {
        HashSet<uint> descendants = new HashSet<uint>();
        bool changed;
        do
        {
            changed = false;
            foreach (KeyValuePair<uint, uint> pair in parents)
            {
                if (pair.Key == rootPid || descendants.Contains(pair.Key)) continue;
                if (pair.Value == rootPid || descendants.Contains(pair.Value))
                {
                    descendants.Add(pair.Key);
                    changed = true;
                }
            }
        }
        while (changed);
        return descendants;
    }

    private static ulong ProcessCreationFiletime(IntPtr handle)
    {
        System.Runtime.InteropServices.ComTypes.FILETIME creation;
        System.Runtime.InteropServices.ComTypes.FILETIME exit;
        System.Runtime.InteropServices.ComTypes.FILETIME kernel;
        System.Runtime.InteropServices.ComTypes.FILETIME user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
            throw new InvalidOperationException("cannot inspect process (Win32 " + Marshal.GetLastWin32Error() + ")");
        return ((ulong)(uint)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
    }

    private static int PrintProcessInstance(string pidInput)
    {
        int pid;
        if (!Int32.TryParse(pidInput, out pid) || pid < 1)
            throw new InvalidOperationException("invalid process id");
        Console.Out.WriteLine(ProcessCreationFiletime((uint)pid).ToString());
        return 0;
    }

    private static ulong ProcessCreationFiletime(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero)
            throw new InvalidOperationException("cannot open process (Win32 " + Marshal.GetLastWin32Error() + ")");
        try
        {
            System.Runtime.InteropServices.ComTypes.FILETIME creation;
            System.Runtime.InteropServices.ComTypes.FILETIME exit;
            System.Runtime.InteropServices.ComTypes.FILETIME kernel;
            System.Runtime.InteropServices.ComTypes.FILETIME user;
            return ProcessCreationFiletime(handle);
        }
        finally { CloseHandle(handle); }
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
            if (ProcessCreationFiletime((uint)System.Diagnostics.Process.GetCurrentProcess().Id) == 0)
                throw new InvalidOperationException("current process creation identity is unavailable");
            Console.Out.WriteLine("operator-path-lease-self-test:ok");
            return 0;
        }
        finally { Directory.Delete(baseDir, true); }
    }
}
