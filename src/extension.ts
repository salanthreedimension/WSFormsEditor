import * as vscode from "vscode";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { DesignerDocument, DesignerMessage } from "./model";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("winformsDesigner.openDesigner", async (resource?: vscode.Uri) => {
    const source = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!source || source.fsPath.toLowerCase().endsWith(".designer.cs")) {
      vscode.window.showWarningMessage("Abra o arquivo .cs do Form ou UserControl para iniciar o Designer.");
      return;
    }

    const workspace = vscode.workspace.getWorkspaceFolder(source);
    if (!workspace) {
      vscode.window.showErrorMessage("O arquivo precisa estar dentro de uma pasta de workspace.");
      return;
    }
    const project = await findWinFormsProject(workspace.uri.fsPath, source.fsPath);
    if (!project) {
      vscode.window.showErrorMessage("Nenhum projeto .NET com UseWindowsForms=true foi encontrado para este arquivo.");
      return;
    }

    const designerPath = source.fsPath.replace(/\.cs$/i, ".Designer.cs");
    if (!(await fileExists(designerPath))) {
      vscode.window.showErrorMessage(`Arquivo de Designer não encontrado: ${path.basename(designerPath)}`);
      return;
    }

    try {
      const panel = vscode.window.createWebviewPanel("winformsVisualDesigner", `Designer: ${path.basename(source.fsPath)}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        retainContextWhenHidden: true
      });
      panel.webview.html = await renderHtml(panel.webview, context.extensionUri);
      let saveQueue: Promise<void> = Promise.resolve();
      let suppressDesignerWatchUntil = 0;
      panel.webview.onDidReceiveMessage(async (message: DesignerMessage) => {
        if (message.type === "ready") {
          try {
            const document = await runRoslyn(context.extensionPath, "read", designerPath);
            panel.webview.postMessage({ type: "load", document, project: path.basename(project) });
          } catch (error) {
            panel.webview.postMessage({ type: "error", message: errorMessage(error) });
          }
        } else if (message.type === "save") {
          saveQueue = saveQueue.then(async () => {
            try {
              suppressDesignerWatchUntil = Date.now() + 1500;
              await runRoslyn(context.extensionPath, "write", designerPath, JSON.stringify(message.document));
              panel.webview.postMessage({ type: "saved" });
            } catch (error) {
              panel.webview.postMessage({ type: "error", message: errorMessage(error) });
            }
          });
        }
      }, undefined, context.subscriptions);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(designerPath), path.basename(designerPath)));
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      watcher.onDidChange(() => {
        if (Date.now() < suppressDesignerWatchUntil) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          try {
            const document = await runRoslyn(context.extensionPath, "read", designerPath);
            panel.webview.postMessage({ type: "load", document, project: path.basename(project) });
          } catch (error) {
            panel.webview.postMessage({ type: "error", message: errorMessage(error) });
          }
        }, 300);
      });
      panel.onDidDispose(() => { watcher.dispose(); if (reloadTimer) clearTimeout(reloadTimer); });
    } catch (error) {
      vscode.window.showErrorMessage(`Não foi possível abrir o Designer: ${errorMessage(error)}`);
    }
  }));
}

export function deactivate(): void {}

async function findWinFormsProject(root: string, source: string): Promise<string | undefined> {
  const projects = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.csproj"), "**/bin/**,**/obj/**", 100);
  const directory = path.dirname(source).toLowerCase();
  const matches: string[] = [];
  for (const uri of projects) {
    const projectPath = uri.fsPath;
    const projectDirectory = path.dirname(projectPath).toLowerCase();
    if (!directory.startsWith(projectDirectory)) continue;
    const content = await vscode.workspace.fs.readFile(uri);
    if (/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(Buffer.from(content).toString("utf8"))) matches.push(projectPath);
  }
  return matches.sort((a, b) => b.length - a.length)[0];
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); return true; }
  catch { return false; }
}

function runRoslyn(extensionPath: string, operation: "read" | "write", designerPath: string, payload?: string): Promise<DesignerDocument> {
  return new Promise((resolve, reject) => {
    const helper = path.join(extensionPath, "roslyn", "WinFormsDesigner.Roslyn.csproj");
    const args = ["run", "--no-launch-profile", "--project", helper, "--", operation, designerPath];
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
      catch (error) { reject(new Error(`Resposta inválida do helper Roslyn: ${errorMessage(error)}\n${stdout}`)); }
    });
  });
}

async function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const nonce = [...Array(32)].map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "designer.css"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "designer.js"));
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><title>WinForms Designer</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }