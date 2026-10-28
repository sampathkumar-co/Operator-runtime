using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace Mecord.WindowsUiaContractApp;

/// <summary>
/// Fully offline, deterministic Windows UI Automation fixture. Only human
/// interaction opens a modal dialog, file chooser or desktop notification.
/// No credentials, network requests or disk writes are performed.
/// </summary>
internal static class Program
{
    internal static readonly string[] ControlIds =
    [
        "main-window", "main-menu", "file-menu", "edit-menu",
        "forms-tab", "data-tab", "name-field", "password-field",
        "save-button", "open-dialog-button", "open-file-button",
        "notification-button", "enabled-checkbox", "priority-dropdown",
        "date-picker", "quantity-spinner", "volume-slider",
        "item-list", "item-tree", "item-table", "status-label"
    ];

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--describe")
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                title = "Mecord UIA Contract Harness",
                deterministic = true,
                networkAccess = false,
                backgroundActions = false,
                interactiveRunner = "run-interactive-uia.ps1",
                targetBinding = "every selector includes this fixture process id",
                interactionCases = new[]
                {
                    "inspect-main-window", "focus-name-field", "set-name-value",
                    "invoke-save", "verify-status", "reject-wrong-process"
                },
                controlIds = ControlIds
            }));
            return;
        }
        if (args.Length != 0)
        {
            Console.Error.WriteLine("Supported fixture argument: --describe");
            Environment.ExitCode = 2;
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new ContractHarnessForm());
    }
}

internal sealed class ContractHarnessForm : Form
{
    private readonly TextBox _name;
    private readonly TextBox _password;
    private readonly ToolStripStatusLabel _status;
    private readonly NotifyIcon _notification;

    internal ContractHarnessForm()
    {
        Name = "main-window";
        AccessibleName = "Mecord UIA Contract Harness";
        Text = "Mecord UIA Contract Harness";
        Size = new Size(980, 720);
        MinimumSize = new Size(700, 500);
        StartPosition = FormStartPosition.CenterScreen;

        _notification = new NotifyIcon
        {
            Icon = SystemIcons.Information,
            Text = "Mecord UIA Fixture",
            Visible = false
        };

        _name = new TextBox
        {
            Name = "name-field", AccessibleName = "Name",
            Width = 310, Text = "Fixture item", PlaceholderText = "Enter name"
        };
        _password = new TextBox
        {
            Name = "password-field", AccessibleName = "Private entry",
            Width = 310, UseSystemPasswordChar = true
        };

        var menu = new MenuStrip { Name = "main-menu", Dock = DockStyle.Top };
        var fileMenu = new ToolStripMenuItem("File") { Name = "file-menu" };
        fileMenu.DropDownItems.Add("Open file...", null, (_, _) => ChooseFile());
        fileMenu.DropDownItems.Add("Exit", null, (_, _) => Close());
        var editMenu = new ToolStripMenuItem("Edit") { Name = "edit-menu" };
        editMenu.DropDownItems.Add("Select name", null, (_, _) => { _name.Focus(); _name.SelectAll(); });
        editMenu.DropDownItems.Add("Clear name", null, (_, _) => { _name.Clear(); SetStatus("Name cleared"); });
        menu.Items.AddRange([fileMenu, editMenu]);
        MainMenuStrip = menu;
        Controls.Add(menu);

        var tabs = new TabControl { Dock = DockStyle.Fill, Name = "fixture-tabs" };
        var forms = new TabPage("Forms") { Name = "forms-tab" };
        var data = new TabPage("Data") { Name = "data-tab" };
        tabs.TabPages.AddRange([forms, data]);

        var formContent = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(20)
        };
        formContent.Controls.Add(new Label { Text = "Name", AutoSize = true });
        formContent.Controls.Add(_name);
        formContent.Controls.Add(new Label { Text = "Private entry (never echoed)", AutoSize = true });
        formContent.Controls.Add(_password);

        var enabled = new CheckBox
        {
            Name = "enabled-checkbox", AccessibleName = "Enabled",
            Text = "Enabled", Checked = true, AutoSize = true
        };
        formContent.Controls.Add(enabled);
        formContent.Controls.Add(new ComboBox
        {
            Name = "priority-dropdown", AccessibleName = "Priority",
            Width = 220, DropDownStyle = ComboBoxStyle.DropDownList,
            Items = { "Low", "Medium", "High" }, SelectedIndex = 1
        });
        formContent.Controls.Add(new DateTimePicker
        {
            Name = "date-picker", AccessibleName = "Requested date",
            Width = 220, Format = DateTimePickerFormat.Short,
            Value = new DateTime(2026, 10, 25)
        });
        formContent.Controls.Add(new NumericUpDown
        {
            Name = "quantity-spinner", AccessibleName = "Quantity",
            Minimum = 0, Maximum = 100, Value = 2, Width = 160
        });
        formContent.Controls.Add(new TrackBar
        {
            Name = "volume-slider", AccessibleName = "Volume",
            Minimum = 0, Maximum = 10, Value = 5, Width = 320
        });
        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = true };
        actions.Controls.Add(MakeButton("save-button", "Save", (_, _) =>
            SetStatus("Saved: " + _name.Text.Trim().Substring(0, Math.Min(40, _name.Text.Trim().Length)))));
        actions.Controls.Add(MakeButton("open-dialog-button", "Open dialog", (_, _) =>
            MessageBox.Show(this, "Deterministic dialog", "Fixture dialog", MessageBoxButtons.OKCancel)));
        actions.Controls.Add(MakeButton("open-file-button", "Choose file", (_, _) => ChooseFile()));
        actions.Controls.Add(MakeButton("notification-button", "Show notification", (_, _) =>
        {
            _notification.Visible = true;
            _notification.ShowBalloonTip(1500, "Fixture notification", "Notification invoked by an explicit click", ToolTipIcon.Info);
            SetStatus("Notification shown");
        }));
        formContent.Controls.Add(actions);
        forms.Controls.Add(formContent);

        var split = new SplitContainer
        {
            Dock = DockStyle.Fill, Orientation = Orientation.Vertical,
            SplitterDistance = 280
        };
        var list = new ListView
        {
            Name = "item-list", AccessibleName = "Item list",
            View = View.Details, FullRowSelect = true, Dock = DockStyle.Top, Height = 240
        };
        list.Columns.Add("Item", 200);
        foreach (var item in new[] { "Alpha", "Beta", "Gamma" }) list.Items.Add(item);
        list.SelectedIndexChanged += (_, _) =>
        {
            if (list.SelectedItems.Count > 0) SetStatus("Selected: " + list.SelectedItems[0].Text);
        };
        var tree = new TreeView
        {
            Name = "item-tree", AccessibleName = "Item tree", Dock = DockStyle.Fill
        };
        var root = tree.Nodes.Add("Root");
        root.Nodes.Add("Child A");
        root.Nodes.Add("Child B");
        root.Expand();
        split.Panel1.Controls.Add(tree);
        split.Panel1.Controls.Add(list);
        var table = new DataGridView
        {
            Name = "item-table", AccessibleName = "Item table",
            Dock = DockStyle.Fill, AllowUserToAddRows = false,
            AllowUserToDeleteRows = false, ReadOnly = true,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect
        };
        table.Columns.Add("id", "ID");
        table.Columns.Add("name", "Name");
        table.Rows.Add("1", "Alpha");
        table.Rows.Add("2", "Beta");
        table.Rows.Add("3", "Gamma");
        split.Panel2.Controls.Add(table);
        data.Controls.Add(split);

        var status = new StatusStrip();
        _status = new ToolStripStatusLabel("Ready") { Name = "status-label" };
        status.Items.Add(_status);
        Controls.Add(tabs);
        Controls.Add(status);
        Controls.SetChildIndex(menu, 0);
        FormClosed += (_, _) => _notification.Dispose();
    }

    private static Button MakeButton(string name, string text, EventHandler handler)
    {
        var button = new Button { Name = name, AccessibleName = text, Text = text, AutoSize = true };
        button.Click += handler;
        return button;
    }

    private void ChooseFile()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Fixture file chooser", CheckFileExists = true,
            Multiselect = false
        };
        SetStatus(dialog.ShowDialog(this) == DialogResult.OK
            ? "File selected (path redacted)" : "File selection cancelled");
    }

    private void SetStatus(string status) => _status.Text = status;
}
