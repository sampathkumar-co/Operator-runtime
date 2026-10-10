using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
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
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const int MAX_PATH = 260;

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
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MAX_PATH)]
        public string szExeFile;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int index);

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
            if (args.Length >= 3 && args[0] == "job-run") return RunInJob(args);
            if (args.Length == 1 && args[0] == "system-roots") return PrintSystemRoots();
            if (args.Length == 2 && args[0] == "process-instance") return PrintProcessInstance(args[1]);
            if (args.Length == 2 && args[0] == "process-tree") return PrintProcessTree(args[1]);
            if (args.Length != 4 || args[0] != "lease")
                throw new InvalidOperationException("usage: operator-windows-path-lease <lease <existing|parent> <root> <target>|system-roots|process-instance <pid>|process-tree <pid>>");
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

    /// <summary>
    /// Run a shell-free child inside a Windows kernel Job Object. The child
    /// is CREATED SUSPENDED, assigned to KILL_ON_JOB_CLOSE, and only then
    /// resumed. Closing/killing this supervising helper therefore terminates
    /// even detached grandchildren; no process table snapshot can race spawn.
    /// The helper inherits only the already-sanitized environment and pipes
    /// supplied by the trusted Node process provider.
    /// </summary>
    private static int RunInJob(string[] args)
    {
        string cwd = args[1];
        string executable = args[2];
        if (!Path.IsPathRooted(cwd) || !Directory.Exists(cwd) ||
            !Path.IsPathRooted(executable) || !File.Exists(executable))
            throw new InvalidOperationException("job-run requires an existing absolute cwd and executable");
        string commandLine = QuoteArgument(executable);
        for (int i = 3; i < args.Length; i++) commandLine += " " + QuoteArgument(args[i]);

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new IOException("cannot create process containment job (Win32 " + Marshal.GetLastWin32Error() + ")");
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool assigned = false;
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new IOException("cannot enable job kill-on-close (Win32 " + Marshal.GetLastWin32Error() + ")");
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            if (!CreateProcess(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
                    true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref startup, out child))
                throw new IOException("cannot launch suspended child (Win32 " + Marshal.GetLastWin32Error() + ")");
            if (!AssignProcessToJobObject(job, child.hProcess))
                throw new IOException("cannot assign child to containment job (Win32 " + Marshal.GetLastWin32Error() + ")");
            assigned = true;
            if (ResumeThread(child.hThread) == WAIT_FAILED)
                throw new IOException("cannot resume contained child (Win32 " + Marshal.GetLastWin32Error() + ")");
            if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0)
                throw new IOException("failed waiting for contained child (Win32 " + Marshal.GetLastWin32Error() + ")");
            uint code;
            if (!GetExitCodeProcess(child.hProcess, out code))
                throw new IOException("cannot read contained child exit status (Win32 " + Marshal.GetLastWin32Error() + ")");
            return code <= 255 ? (int)code : 1;
        }
        finally
        {
            // A suspended, unassigned process is never allowed to run.
            if (child.hProcess != IntPtr.Zero && !assigned) TerminateProcess(child.hProcess, 1);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            // Also kills descendants which detached from an otherwise exited
            // root. On supervisor crash Windows closes this process's handle.
            CloseHandle(job);
        }
    }

    private static string QuoteArgument(string argument)
    {
        StringBuilder output = new StringBuilder();
        output.Append('"');
        int slashes = 0;
        foreach (char ch in argument)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
            }
            else
            {
                output.Append('\\', slashes);
                output.Append(ch);
            }
            slashes = 0;
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
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

    private static int PrintProcessInstance(string pidInput)
    {
        int pid;
        if (!Int32.TryParse(pidInput, out pid) || pid < 1)
            throw new InvalidOperationException("invalid process id");
        Console.Out.WriteLine(ProcessCreationFiletime((uint)pid).ToString());
        return 0;
    }

    private static int PrintProcessTree(string pidInput)
    {
        int rootPid;
        if (!Int32.TryParse(pidInput, out rootPid) || rootPid < 1)
            throw new InvalidOperationException("invalid process id");
        foreach (KeyValuePair<uint, int> item in EnumerateProcessTree((uint)rootPid))
        {
            try
            {
                Console.Out.WriteLine(item.Key.ToString() + ":" + ProcessCreationFiletime(item.Key).ToString() + ":" + item.Value.ToString());
            }
            catch
            {
                // Process exited between the snapshot and identity read. A process
                // that is already gone needs no termination authority.
            }
        }
        return 0;
    }

    private static List<KeyValuePair<uint, int>> EnumerateProcessTree(uint rootPid)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new InvalidOperationException("cannot snapshot process table (Win32 " + Marshal.GetLastWin32Error() + ")");
        try
        {
            Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    if (entry.th32ProcessID > 0) parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                }
                while (Process32Next(snapshot, ref entry));
            }

            Dictionary<uint, int> depths = new Dictionary<uint, int>();
            depths[rootPid] = 0;
            bool changed = true;
            while (changed)
            {
                changed = false;
                foreach (KeyValuePair<uint, uint> process in parents)
                {
                    if (depths.ContainsKey(process.Key)) continue;
                    int parentDepth;
                    if (!depths.TryGetValue(process.Value, out parentDepth)) continue;
                    depths[process.Key] = parentDepth + 1;
                    changed = true;
                }
            }

            List<KeyValuePair<uint, int>> result = new List<KeyValuePair<uint, int>>(depths);
            result.Sort(delegate(KeyValuePair<uint, int> left, KeyValuePair<uint, int> right)
            {
                int depth = right.Value.CompareTo(left.Value);
                return depth != 0 ? depth : right.Key.CompareTo(left.Key);
            });
            return result;
        }
        finally
        {
            CloseHandle(snapshot);
        }
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
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("cannot inspect process (Win32 " + Marshal.GetLastWin32Error() + ")");
            return ((ulong)(uint)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
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
            uint currentPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            if (ProcessCreationFiletime(currentPid) == 0)
                throw new InvalidOperationException("current process creation identity is unavailable");
            List<KeyValuePair<uint, int>> tree = EnumerateProcessTree(currentPid);
            if (!tree.Exists(delegate(KeyValuePair<uint, int> item) { return item.Key == currentPid && item.Value == 0; }))
                throw new InvalidOperationException("current process tree root is unavailable");
            Console.Out.WriteLine("operator-path-lease-self-test:ok");
            return 0;
        }
        finally { Directory.Delete(baseDir, true); }
    }
}
