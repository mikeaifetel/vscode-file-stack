import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Define types for our file stacks
interface FileStackItem {
  filePath: string;
  displayName: string;
}

interface FileStack {
  name: string;
  files: FileStackItem[];
}

interface FileStackCollection {
  [workspaceFolder: string]: FileStack[];
}

export function activate(context: vscode.ExtensionContext) {
  // Create our file stacks provider
  const fileStackProvider = new FileStackProvider(context);

  // Register the tree data provider for the sidebar view
  vscode.window.registerTreeDataProvider('fileStackView', fileStackProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('file-stack.createStack', () => {
      fileStackProvider.createStack();
    }),

    vscode.commands.registerCommand('file-stack.addToStack', (resource: vscode.Uri | FileStackNode) => {
      // If resource is a FileStackNode, it means we're adding the current file to a specific stack
      if (resource instanceof FileStackNode) {
        fileStackProvider.addCurrentFileToStack(resource);
      } else {
        fileStackProvider.addToStack(resource);
      }
    }),

    vscode.commands.registerCommand('file-stack.openStack', (stackNode: FileStackNode) => {
      fileStackProvider.openStack(stackNode, false);
    }),

    vscode.commands.registerCommand('file-stack.openStackAndCloseOthers', (stackNode: FileStackNode) => {
      fileStackProvider.openStack(stackNode, true);
    }),

    vscode.commands.registerCommand('file-stack.renameStack', (stackNode: FileStackNode) => {
      fileStackProvider.renameStack(stackNode);
    }),

    vscode.commands.registerCommand('file-stack.deleteStack', (stackNode: FileStackNode) => {
      fileStackProvider.deleteStack(stackNode);
    }),

    vscode.commands.registerCommand('file-stack.removeFromStack', (fileNode: FileStackItemNode) => {
      fileStackProvider.removeFromStack(fileNode);
    }),
    vscode.commands.registerCommand('file-stack.addAllOpenFilesToStack', (stackNode: FileStackNode) => {
      fileStackProvider.addAllOpenFilesToStack(stackNode);
    })
  );

  // Set up donation reminder
  setupDonationReminder(context);
}

// This method is called when your extension is deactivated
export function deactivate() {}

// Set up donation reminder to show every 3-5 days
function setupDonationReminder(context: vscode.ExtensionContext) {
  // Check if we need to show the donation prompt
  const lastPromptDate = context.globalState.get<number>('fileStack.lastDonationPrompt', 0);
  const now = Date.now();

  // Calculate days since last prompt (3-5 days in milliseconds)
  const minInterval = 3 * 24 * 60 * 60 * 1000; // 3 days
  const maxInterval = 5 * 24 * 60 * 60 * 1000; // 5 days

  // Generate a random interval between min and max
  const randomInterval = Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;

  // Check if enough time has passed
  if (1 || now - lastPromptDate >= randomInterval) {
    // Show donation prompt
    showDonationPrompt(context);
  }

  // Schedule next check
  setTimeout(() => {
    setupDonationReminder(context);
  }, 24 * 60 * 60 * 1000); // Check daily
}

// Show donation prompt to user
async function showDonationPrompt(context: vscode.ExtensionContext) {
  const result = await vscode.window.showInformationMessage(
    'Do you find File Stack extension useful? Consider supporting its development!',
    'GitHub Sponsor',
    'Maybe Later',
    'Don\'t Show Again'
  );

  // Update last prompt date
  context.globalState.update('fileStack.lastDonationPrompt', Date.now());

  // Handle user selection
  switch (result) {
    case 'GitHub Sponsor':
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/sponsors/mikeaifetel'));
      break;
    case 'Maybe Later':
      break;
    case 'Don\'t Show Again':
      // Set a very large value to prevent showing again
      context.globalState.update('fileStack.lastDonationPrompt', Number.MAX_SAFE_INTEGER);
      break;
  }
}

// Tree data provider for File Stacks
class FileStackProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  // Add all opened files to the current Stack
  async addAllOpenFilesToStack(stackNode: FileStackNode) {
    const documents = vscode.workspace.textDocuments;
    if (!documents || documents.length === 0) {
      vscode.window.showInformationMessage('No open documents to add');
      return;
    }
    const stacks = this.getFileStacks();
    const stack = stacks.find(s => s.name === stackNode.label);
    if (!stack) {
      vscode.window.showErrorMessage('Target stack not found');
      return;
    }
    let addedCount = 0;
    for (const doc of documents) {
      if (!doc.isUntitled && doc.uri.scheme === 'file') {
        const filePath = doc.uri.fsPath;
        const displayName = path.basename(filePath);
        if (!stack.files.some(f => f.filePath === filePath)) {
          stack.files.push({ filePath, displayName });
          addedCount++;
        }
      }
    }
    if (addedCount > 0) {
      this.saveFileStacks();
      vscode.window.showInformationMessage(`Added ${addedCount} files to File Stack: ${stackNode.label}`);
    } else {
      vscode.window.showInformationMessage('All open files are already in this Stack');
    }
  }

  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null> = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null> = this._onDidChangeTreeData.event;

  private context: vscode.ExtensionContext;
  private fileStacks: FileStackCollection = {};

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadFileStacks();
  }

  // Add current file to a specific stack
  async addCurrentFileToStack(stackNode: FileStackNode) {
    // Get the active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active file to add to File Stack');
      return;
    }

    const resource = activeEditor.document.uri;
    const filePath = resource.fsPath;
    const displayName = path.basename(filePath);

    // Find the stack
    const stacks = this.getFileStacks();
    const stack = stacks.find(s => s.name === stackNode.label);

    if (stack) {
      // Check if file already exists in the stack
      if (!stack.files.some(f => f.filePath === filePath)) {
        stack.files.push({
          filePath,
          displayName
        });
        this.saveFileStacks();
        vscode.window.showInformationMessage(`Added ${displayName} to File Stack: ${stackNode.label}`);
      } else {
        vscode.window.showInformationMessage(`File ${displayName} is already in File Stack: ${stackNode.label}`);
      }
    }
  }

  // Load file stacks from storage
  private loadFileStacks() {
    const storedStacks = this.context.workspaceState.get<FileStackCollection>('fileStacks');
    if (storedStacks) {
      this.fileStacks = storedStacks;
    }
  }

  // Save file stacks to storage
  private saveFileStacks() {
    this.context.workspaceState.update('fileStacks', this.fileStacks);
    this._onDidChangeTreeData.fire(undefined);
  }

  // Get current workspace folder key
  private getCurrentWorkspaceKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? workspaceFolder.uri.toString() : 'global';
  }

  // Get file stacks for current workspace
  private getFileStacks(): FileStack[] {
    const key = this.getCurrentWorkspaceKey();
    if (!this.fileStacks[key]) {
      this.fileStacks[key] = [];
    }
    return this.fileStacks[key];
  }

  // Create a new file stack
  async createStack() {
    const name = await vscode.window.showInputBox({
      placeHolder: 'Enter a name for the new File Stack',
      prompt: 'Create File Stack'
    });

    if (name) {
      const stacks = this.getFileStacks();
      stacks.push({
        name,
        files: []
      });
      this.saveFileStacks();
    }
  }

  // Add a file to a File Stack
  async addToStack(resource?: vscode.Uri) {
    // If no resource is provided, use the active editor
    if (!resource && vscode.window.activeTextEditor) {
      resource = vscode.window.activeTextEditor.document.uri;
    }

    if (!resource) {
      vscode.window.showErrorMessage('No file selected to add to File Stack');
      return;
    }

    const stacks = this.getFileStacks();
    if (stacks.length === 0) {
      const createNew = await vscode.window.showInformationMessage(
        'No File Stacks exist. Create one?',
        'Yes',
        'No'
      );

      if (createNew === 'Yes') {
        await this.createStack();
      } else {
        return;
      }
    }

    // Ask user which stack to add to
    const stackNames = stacks.map(s => s.name);
    const createNewOption = '$(add) Create New Stack';
    const quickPickOptions = [createNewOption, ...stackNames];

    const selectedOption = await vscode.window.showQuickPick(quickPickOptions, {
      placeHolder: 'Select a File Stack to add the file to'
    });

    if (selectedOption) {
      if (selectedOption === createNewOption) {
        // Create a new stack and then add the file to it
        const newStackName = await vscode.window.showInputBox({
          placeHolder: 'Enter a name for the new File Stack',
          prompt: 'Create New File Stack'
        });

        if (newStackName) {
          // Create the new stack
          const newStack: FileStack = {
            name: newStackName,
            files: []
          };

          // Add the file to the new stack
          const filePath = resource.fsPath;
          const displayName = path.basename(filePath);

          newStack.files.push({
            filePath,
            displayName
          });

          // Add the new stack to the collection and save
          stacks.push(newStack);
          this.saveFileStacks();

          // Refresh the view
          this._onDidChangeTreeData.fire(null);
        }
      } else {
        // Add to existing stack
        const selectedStack = stacks.find(s => s.name === selectedOption);
        if (selectedStack) {
          const filePath = resource.fsPath;
          const displayName = path.basename(filePath);

          // Check if file already exists in the stack
          if (!selectedStack.files.some(f => f.filePath === filePath)) {
            selectedStack.files.push({
              filePath,
              displayName
            });
            this.saveFileStacks();
            this._onDidChangeTreeData.fire(null);
          }
        }
      }
    }
  }

  // Open all files in a File Stack
  async openStack(stackNode: FileStackNode, closeOthers: boolean) {
    const stacks = this.getFileStacks();
    const stack = stacks.find(s => s.name === stackNode.label);

    if (stack) {
      // If closeOthers is true, close all editors first
      if (closeOthers) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }

      // Open all files in the stack
      for (const file of stack.files) {
        try {
          const doc = await vscode.workspace.openTextDocument(file.filePath);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showWarningMessage(`Failed to open ${file.displayName}: File may have been moved or deleted.`);
        }
      }
    }
  }

  // Rename a File Stack
  async renameStack(stackNode: FileStackNode) {
    const stacks = this.getFileStacks();
    const stack = stacks.find(s => s.name === stackNode.label);

    if (stack) {
      const newName = await vscode.window.showInputBox({
        placeHolder: 'Enter a new name for the File Stack',
        prompt: 'Rename File Stack',
        value: stack.name
      });

      if (newName && newName !== stack.name) {
        stack.name = newName;
        this.saveFileStacks();
      }
    }
  }

  // Delete a File Stack
  async deleteStack(stackNode?: FileStackNode) {
    const stacks = this.getFileStacks();

    // If no stackNode is provided, let the user select one
    if (!stackNode) {
      if (stacks.length === 0) {
        vscode.window.showInformationMessage('No File Stacks available to delete.');
        return;
      }

      const stackNames = stacks.map(s => s.name);
      const selectedStackName = await vscode.window.showQuickPick(stackNames, {
        placeHolder: 'Select a File Stack to delete',
      });

      if (!selectedStackName) {
        return; // User cancelled the selection
      }

      // Create a temporary stack node for the selected stack
      stackNode = new FileStackNode(selectedStackName, vscode.TreeItemCollapsibleState.None);
    }

    const stackIndex = stacks.findIndex(s => s.name === stackNode!.label);

    if (stackIndex === -1) {
      vscode.window.showErrorMessage(`File Stack "${stackNode.label}" not found.`);
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the File Stack "${stackNode.label}"? This action cannot be undone.`,
      { modal: true },
      'Delete',
      'Cancel'
    );

    if (confirm === 'Delete') {
      stacks.splice(stackIndex, 1);
      this.saveFileStacks();
      this._onDidChangeTreeData.fire(undefined); // Refresh the tree view
      vscode.window.showInformationMessage(`File Stack "${stackNode.label}" has been deleted.`);
    }
  }

  // Remove a file from a File Stack
  async removeFromStack(fileNode?: FileStackItemNode) {
    // If fileNode is not provided, try to get the current active file
    if (!fileNode) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showWarningMessage('No active file to remove from stack');
        return;
      }

      const currentFilePath = activeEditor.document.uri.fsPath;
      const stacks = this.getFileStacks();

      // Find all stacks that contain this file
      const stacksWithFile: { stack: FileStack, fileIndex: number }[] = [];

      stacks.forEach(stack => {
        const fileIndex = stack.files.findIndex(f => f.filePath === currentFilePath);
        if (fileIndex !== -1) {
          stacksWithFile.push({ stack, fileIndex });
        }
      });

      // If file is in multiple stacks, ask user which one to remove from
      if (stacksWithFile.length > 1) {
        const stackNames = stacksWithFile.map(item => item.stack.name);
        const selectedStack = await vscode.window.showQuickPick(stackNames, {
          placeHolder: 'Select which stack to remove the file from'
        });

        if (selectedStack) {
          const selectedItem = stacksWithFile.find(item => item.stack.name === selectedStack);
          if (selectedItem) {
            selectedItem.stack.files.splice(selectedItem.fileIndex, 1);
            this.saveFileStacks();
            this._onDidChangeTreeData.fire(null);
            vscode.window.showInformationMessage(`Removed file from stack: ${selectedStack}`);
          }
        }
      }
      // If file is in only one stack, remove it directly
      else if (stacksWithFile.length === 1) {
        const { stack, fileIndex } = stacksWithFile[0];
        stack.files.splice(fileIndex, 1);
        this.saveFileStacks();
        this._onDidChangeTreeData.fire(null);
        vscode.window.showInformationMessage(`Removed file from stack: ${stack.name}`);
      }
      else {
        vscode.window.showWarningMessage('Current file is not in any stack');
      }

      return;
    }

    // Original implementation for when fileNode is provided
    const stacks = this.getFileStacks();
    const stack = stacks.find(s => s.name === fileNode.parent);

    if (stack) {
      const fileIndex = stack.files.findIndex(f => f.filePath === fileNode.filePath);
      if (fileIndex !== -1) {
        stack.files.splice(fileIndex, 1);
        this.saveFileStacks();
        this._onDidChangeTreeData.fire(null);
      }
    }
  }

  // TreeDataProvider implementation
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      // Root level - show all stacks
      const stacks = this.getFileStacks();
      return Promise.resolve(stacks.map(stack => new FileStackNode(
        stack.name,
        stack.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      )));
    } else if (element instanceof FileStackNode) {
      // Stack level - show all files in the stack
      const stacks = this.getFileStacks();
      const stack = stacks.find(s => s.name === element.label);

      if (stack) {
        return Promise.resolve(stack.files.map(file => new FileStackItemNode(
          file.displayName,
          file.filePath,
          element.label as string
        )));
      }
    }

    return Promise.resolve([]);
  }
}

// Tree node representing a File Stack
class FileStackNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.contextValue = 'fileStack';
    this.tooltip = `File Stack: ${label}`;
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

// Tree node representing a file in a File Stack
class FileStackItemNode extends vscode.TreeItem {
  buttons?: { iconPath: vscode.ThemeIcon; tooltip: string; command: { command: string; title: string; arguments: any[] } }[];
  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly parent: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    // Restore contextValue for right-click menu functionality
    this.contextValue = 'fileStackItem';
    this.tooltip = filePath;
    this.command = {
      command: 'vscode.open',
      arguments: [vscode.Uri.file(filePath)],
      title: 'Open File'
    };

    // Set icon based on file type
    this.resourceUri = vscode.Uri.file(filePath);

    // Add tooltip with instructions
    this.tooltip = `${filePath} (Click to open)`;
  }
}
