# WinForms Visual Designer for VS Code

Extensão experimental para criar e editar a interface de projetos Windows Forms no VS Code Desktop. O Designer oferece toolbox (Form, Panel, Button, Label e TextBox), canvas com seleção/movimentação, oito alças de resize, snap e guias de alinhamento, preview interativo com elementos HTML nativos, árvore de controles, PropertyGrid, undo/redo e salvamento automático.

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

O helper usa Roslyn para preservar assignments não gerenciados e handlers, atualizar propriedades de layout/cores/fontes e editar o evento `Click` sem substituir o método associado. Ele reconhece tanto corpos em bloco quanto inicializadores expression-bodied diretos. O host detecta projetos `net*-windows` com controles WinForms mesmo quando `UseWindowsForms` vem de configuração importada, detecta alterações no arquivo em disco antes de salvar, permite recarregar ou confirmar sobrescrita, e executa `dotnet build` para mostrar erros. Controles existentes de tipos ainda não suportados permanecem no código e aparecem como diagnósticos.

## Empacotar

Execute `npm run package` para gerar o VSIX. Para instalar, use **Extensions: Install from VSIX...** no VS Code.

## Limites atuais

O preview usa controles HTML do Webview e não executa assemblies WinForms nem código C#; `Click` é editável e exibido no preview, mas o handler C# não é executado dentro dele. Permanecem fora do MVP a edição de eventos além de `Click`, a interpretação de todas as expressões C# possíveis (por exemplo, recursos e inicializadores complexos) e a prevenção de conflito com alterações ainda não salvas no buffer do editor. O projeto precisa compilar como WinForms para que o helper possa validar o resultado.