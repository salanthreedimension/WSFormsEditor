# WinForms Visual Designer for VS Code

Extensão experimental para criar e editar a interface de projetos Windows Forms no VS Code Desktop. O MVP oferece toolbox (Form, Panel, Button, Label e TextBox), canvas com seleção/movimentação/redimensionamento em grade de 8 px, árvore de controles, propriedades, salvamento automático e undo/redo.

## Executar em desenvolvimento

1. Instale Node.js e o .NET SDK 10 no Windows.
2. Execute `npm install` e `npm run compile` na raiz.
3. Abra **Run and Debug** no VS Code e inicie **Run WinForms Designer Extension**.
4. Na janela Extension Development Host, abra `samples/WinFormsSample/Form1.cs` e use **WinForms: Open Visual Designer** na barra do editor ou na Command Palette.

O helper Roslyn é executado com `dotnet run` e pode restaurar `Microsoft.CodeAnalysis.CSharp` na primeira inicialização. O projeto de exemplo é independente e pode ser compilado com `dotnet build samples/WinFormsSample/WinFormsSample.csproj`.

## Arquitetura

- `src/`: extensão TypeScript, detecção de projeto e protocolo Extension Host ↔ Webview.
- `media/`: aplicação do Designer, estado UI e interação do canvas.
- `roslyn/`: helper .NET que analisa `InitializeComponent` com Roslyn e atualiza sintaticamente campos, inicializações, propriedades visuais e `Controls.Add`.
- `samples/WinFormsSample/`: Form de teste com código de evento manual.

O helper preserva assignments não gerenciados, incluindo handlers, e não reescreve o arquivo inteiro com formatação normalizada. O modelo atual edita `Location`, `Size`, `Text`, `BackColor`, `Enabled` e `Visible`; controles existentes de tipos ainda não suportados permanecem no código e aparecem como diagnósticos. A leitura externa do `.Designer.cs` ocorre ao abrir o Designer; alterações feitas no editor C# enquanto o painel já está aberto ainda não são recarregadas automaticamente.

## Empacotar

Execute `npm run package` para gerar o VSIX. Para instalar, use **Extensions: Install from VSIX...** no VS Code.

## Limites atuais

O MVP não executa o Form dentro do Webview: o canvas é uma representação visual aproximada. Ainda não há suporte a eventos editáveis, anchors/dock, fontes, guias de alinhamento, resize em oito handles, resolução de conflitos de edição simultânea ou importação de todos os tipos de expressão C# para cor/fonte. Os arquivos WinForms devem ter um `InitializeComponent()` em bloco e o `.csproj` deve declarar `<UseWindowsForms>true</UseWindowsForms>`.