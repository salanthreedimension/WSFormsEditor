/// <reference types="node" />

import * as vscode from "vscode";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { clearTimeout, setTimeout } from "timers";
import { createHash } from "crypto";
import { DesignerDocument, DesignerMessage } from "./model";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("winformsDesigner.openDesigner", async (resource?: vscode.Uri) => {
    const source = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!source || !source.fsPath.toLowerCase().endsWith(".cs")) {
      vscode.window.showWarningMessage("Open a Form or UserControl .cs file to start the designer.");
      return;
    }

    const selectedDesignerFile = /\.Designer\.cs$/i.test(source.fsPath);
    const formPath = selectedDesignerFile ? source.fsPath.replace(/\.Designer\.cs$/i, ".cs") : source.fsPath;
    let designerPath = selectedDesignerFile ? source.fsPath : formPath.replace(/\.cs$/i, ".Designer.cs");
    if (!(await fileExists(designerPath))) {
      if (selectedDesignerFile || !(await containsSupportedLayout(formPath))) {
        vscode.window.showErrorMessage(`Designer file not found: ${path.basename(designerPath)}. The Form must contain InitializeComponent() or recognizable WinForms control creation and Controls.Add code.`);
        return;
      }
      designerPath = formPath;
    }
    if (findOpenDocument(designerPath)?.isDirty || (designerPath.toLowerCase() !== formPath.toLowerCase() && findOpenDocument(formPath)?.isDirty)) {
      vscode.window.showWarningMessage("Save the Form and layout files before opening the visual designer.");
      return;
    }

    const workspace = vscode.workspace.getWorkspaceFolder(source);
    if (!workspace) {
      vscode.window.showErrorMessage("The file must be inside a workspace folder.");
      return;
    }
    const project = await findWinFormsProject(workspace.uri.fsPath, source.fsPath, designerPath);
    if (!project) {
      vscode.window.showErrorMessage("No WinForms .NET project was found for this file. Enable UseWindowsForms or target Windows.");
      return;
    }
    const projectPath = project;

    try {
      const panel = vscode.window.createWebviewPanel("winformsVisualDesigner", `Designer: ${path.basename(formPath)}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        retainContextWhenHidden: true
      });
      panel.webview.html = await renderHtml(panel.webview, context.extensionUri);
      let saveQueue: Promise<void> = Promise.resolve();
      let suppressDesignerWatchUntil = 0;
      let lastDesignerHash = "";
      let designerReadOnly = false;
      let activeLayoutPath = designerPath;
      let buildTimer: ReturnType<typeof setTimeout> | undefined;
      let nativeProcess: ChildProcess | undefined;
      let panelDisposed = false;
      panel.webview.onDidReceiveMessage(async (message: DesignerMessage) => {
        if (message.type === "ready") {
          await loadDesigner();
        } else if (message.type === "reload") {
          if (findOpenDocument(activeLayoutPath)?.isDirty) panel.webview.postMessage({ type: "conflict", reason: "buffer" });
          else await loadDesigner();
        } else if (message.type === "run") {
          await runNativePreview();
        } else if (message.type === "stop") {
          stopNativePreview();
        } else if (message.type === "save") {
          saveQueue = saveQueue.then(async () => {
            try {
              if (designerReadOnly) {
                panel.webview.postMessage({ type: "error", message: "The layout contains UI construction patterns that cannot be edited safely." });
                return;
              }
              const openDesigner = findOpenDocument(activeLayoutPath);
              if (openDesigner?.isDirty) {
                if (!message.force) { panel.webview.postMessage({ type: "conflict", reason: "buffer" }); return; }
                suppressDesignerWatchUntil = Date.now() + 1500;
                const saved = await vscode.workspace.save(openDesigner.uri);
                if (!saved) { panel.webview.postMessage({ type: "conflict", reason: "buffer" }); return; }
              }
              const currentHash = await fileHash(activeLayoutPath);
              if (!message.force && lastDesignerHash && currentHash !== lastDesignerHash) {
                panel.webview.postMessage({ type: "conflict" });
                return;
              }
              suppressDesignerWatchUntil = Date.now() + 1500;
              await runRoslyn(context.extensionPath, "write", activeLayoutPath, JSON.stringify(message.document));
              lastDesignerHash = await fileHash(activeLayoutPath);
              panel.webview.postMessage({ type: "saved" });
              if (buildTimer) clearTimeout(buildTimer);
              buildTimer = setTimeout(async () => {
                const errors = await buildProject(projectPath);
                panel.webview.postMessage({ type: "build", errors });
              }, 900);
            } catch (error) {
              panel.webview.postMessage({ type: "error", message: errorMessage(error) });
            }
          });
        }
      }, undefined, context.subscriptions);
      const watchedPaths = [...new Set([designerPath, formPath].map(filePath => path.resolve(filePath).toLowerCase()))]
        .map(filePath => filePath === path.resolve(designerPath).toLowerCase() ? designerPath : formPath);
      const watchers = watchedPaths.map(filePath =>
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))));
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      const bufferListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (path.resolve(event.document.uri.fsPath).toLowerCase() === path.resolve(activeLayoutPath).toLowerCase() && event.document.isDirty)
          panel.webview.postMessage({ type: "conflict", reason: "buffer" });
      });
      const onLayoutChanged = (event: vscode.Uri): void => {
        if (path.resolve(event.fsPath).toLowerCase() !== path.resolve(activeLayoutPath).toLowerCase() || Date.now() < suppressDesignerWatchUntil) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          try {
            const changedHash = await fileHash(activeLayoutPath);
            if (lastDesignerHash && changedHash !== lastDesignerHash) panel.webview.postMessage({ type: "conflict" });
          } catch (error) {
            panel.webview.postMessage({ type: "error", message: errorMessage(error) });
          }
        }, 300);
      };
      for (const watcher of watchers) {
        watcher.onDidChange(onLayoutChanged);
      }
      panel.onDidDispose(() => {
        panelDisposed = true;
        for (const watcher of watchers) watcher.dispose();
        bufferListener.dispose();
        if (reloadTimer) clearTimeout(reloadTimer);
        if (buildTimer) clearTimeout(buildTimer);
        stopNativePreview();
      });

      async function loadDesigner(): Promise<void> {
        try {
          const codeBehindPath = await fileExists(formPath) ? formPath : undefined;
          const document = await runRoslyn(context.extensionPath, "read", designerPath, undefined, codeBehindPath);
          activeLayoutPath = document.layoutSource === "codeBehind" ? formPath : designerPath;
          if (findOpenDocument(activeLayoutPath)?.isDirty) {
            panel.webview.postMessage({ type: "error", message: "Save the file containing the detected layout code, then reload the designer." });
            return;
          }
          designerReadOnly = document.readOnly === true;
          lastDesignerHash = await fileHash(activeLayoutPath);
          panel.webview.postMessage({ type: "load", document, project: path.basename(projectPath) });
        } catch (error) {
          panel.webview.postMessage({ type: "error", message: errorMessage(error) });
        }
      }

      async function runNativePreview(): Promise<void> {
        if (nativeProcess) { panel.webview.postMessage({ type: "native", running: true }); return; }
        await saveQueue;
        const projectDirectory = path.resolve(path.dirname(projectPath)).toLowerCase();
        const dirtySources = vscode.workspace.textDocuments.filter(document =>
          document.isDirty && document.languageId === "csharp" && path.resolve(document.uri.fsPath).toLowerCase().startsWith(projectDirectory + path.sep));
        if (dirtySources.length > 0) {
          panel.webview.postMessage({ type: "error", message: "Save open C# project files before running the Form." });
          return;
        }
        panel.webview.postMessage({ type: "native", running: false, building: true, message: "Building WinForms project..." });
        if (buildTimer) clearTimeout(buildTimer);
        const errors = await buildProject(projectPath);
        if (errors.length > 0) {
          panel.webview.postMessage({ type: "build", errors });
          panel.webview.postMessage({ type: "native", running: false, building: false, message: "Fix build errors before running the Form." });
          return;
        }
        if (panelDisposed) return;
        const child = spawn("dotnet", ["run", "--project", projectPath, "--no-build"], { cwd: path.dirname(projectPath), windowsHide: true });
        nativeProcess = child;
        let runtimeOutput = "";
        child.stderr.setEncoding("utf8").on("data", (part: string) => { runtimeOutput += part; });
        child.on("error", error => {
          if (nativeProcess === child) nativeProcess = undefined;
          if (!panelDisposed) {
            panel.webview.postMessage({ type: "error", message: errorMessage(error) });
            panel.webview.postMessage({ type: "native", running: false, building: false });
          }
        });
        child.on("close", code => {
          if (nativeProcess === child) nativeProcess = undefined;
          if (!panelDisposed) panel.webview.postMessage({ type: "native", running: false, message: runtimeOutput.trim() || `Form exited (${code ?? "no exit code"}).` });
        });
        panel.webview.postMessage({ type: "native", running: true, message: "WinForms Form is running in a native window." });
      }

      function stopNativePreview(): void {
        if (!nativeProcess) return;
        const child = nativeProcess;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else child.kill();
        nativeProcess = undefined;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open the designer: ${errorMessage(error)}`);
    }
  }));
}

export function deactivate(): void {}

async function findWinFormsProject(root: string, source: string, designerPath: string): Promise<string | undefined> {
  const projects = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.csproj"), "**/bin/**,**/obj/**", 100);
  const directory = path.dirname(source).toLowerCase();
  const matches: string[] = [];
  for (const uri of projects) {
    const projectPath = uri.fsPath;
    const projectDirectory = path.dirname(projectPath).toLowerCase();
    if (!directory.startsWith(projectDirectory)) continue;
    const content = await vscode.workspace.fs.readFile(uri);
    const projectText = Buffer.from(content).toString("utf8");
    const explicitWinForms = /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(projectText);
    const windowsTarget = /<TargetFrameworks?>\s*[^<]*-windows[^<]*<\/TargetFrameworks?>/i.test(projectText);
    const designerText = await fileExists(designerPath)
      ? Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(designerPath))).toString("utf8")
      : "";
    const hasWinFormsTypes = /System\.Windows\.Forms|:\s*(?:Form|UserControl)\b/.test(designerText);
    if (explicitWinForms || (windowsTarget && hasWinFormsTypes)) matches.push(projectPath);
  }
  return matches.sort((a, b) => b.length - a.length)[0];
}

async function containsSupportedLayout(filePath: string): Promise<boolean> {
  try {
    const openDocument = findOpenDocument(filePath);
    const source = openDocument?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString("utf8");
    return /\bInitializeComponent\s*\([^)]*\)\s*(?:\{|=>)/s.test(source) ||
      /\b(?:new\s+(?:System\.Windows\.Forms\.)?(?:Panel|Button|Label|TextBox|RichTextBox|CheckBox|RadioButton|ComboBox|ListBox|PictureBox|GroupBox|TabControl|DataGridView)\b[\s({]|Controls\s*\.\s*Add\s*\()/s.test(source);
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); return true; }
  catch { return false; }
}

function findOpenDocument(filePath: string): vscode.TextDocument | undefined {
  const target = path.resolve(filePath).toLowerCase();
  return vscode.workspace.textDocuments.find(document => path.resolve(document.uri.fsPath).toLowerCase() === target);
}

async function fileHash(filePath: string): Promise<string> {
  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  return createHash("sha256").update(content).digest("hex");
}

function buildProject(projectPath: string): Promise<string[]> {
  return new Promise(resolve => {
    const child = spawn("dotnet", ["build", projectPath, "--nologo", "--verbosity", "minimal"], { cwd: path.dirname(projectPath), windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { output += part; });
    child.on("error", error => resolve([errorMessage(error)]));
    child.on("close", code => {
      const errors = output.split(/\r?\n/).filter(line => /\berror\s+[A-Z]+\d+:/i.test(line));
      if (code !== 0 && errors.length === 0) errors.push(`dotnet build exited with code ${code}.`);
      resolve(errors);
    });
  });
}

function runRoslyn(extensionPath: string, operation: "read" | "write", designerPath: string, payload?: string, codeBehindPath?: string): Promise<DesignerDocument> {
  return new Promise((resolve, reject) => {
    const helper = path.join(extensionPath, "roslyn", "WinFormsDesigner.Roslyn.csproj");
    const args = ["run", "--no-launch-profile", "--project", helper, "--", operation, designerPath];
    if (operation === "read" && codeBehindPath) args.push(codeBehindPath);
    const child = spawn("dotnet", args, { cwd: extensionPath, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    if (payload) child.stdin.end(payload);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `Roslyn helper exited with code ${code}`)); return; }
      try { resolve(stdout.trim() ? JSON.parse(stdout) as DesignerDocument : { formName: "", controls: [], diagnostics: [] }); }
      catch (error) { reject(new Error(`Invalid response from Roslyn helper: ${errorMessage(error)}\n${stdout}`)); }
    });
  });
}

async function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const nonce = [...Array(32)].map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "designer.css"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "designer.js"));
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:;`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><title>WinForms Designer</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }