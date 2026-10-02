# WinForms Visual Designer for VS Code

Extensão experimental para criar e editar a interface de projetos Windows Forms no VS Code Desktop. A Toolbox inclui Form, Panel, Button, Label, TextBox, RichTextBox, CheckBox, RadioButton, ComboBox, ListBox, PictureBox, GroupBox, TabControl e DataGridView. O canvas oferece drag-and-drop em containers, seleção múltipla, oito alças, snap e guias; o preview aplica Anchor/Dock e usa widgets HTML equivalentes. **Executar Form** compila e abre o aplicativo WinForms real em uma janela nativa separada; **Encerrar** fecha esse processo.

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

O helper usa Roslyn para preservar assignments e expressões não gerenciadas, atualizar layout, cores, fontes, itens de listas e method groups de eventos WinForms sem substituir os métodos associados. Reconhece corpos em bloco e inicializadores expression-bodied diretos. O host detecta projetos `net*-windows`, observa mudanças no disco e em buffers C# abertos, permite recarregar ou confirmar salvar/sobrescrever, e executa `dotnet build` para mostrar erros. Controles existentes fora da Toolbox permanecem no código e aparecem como diagnósticos.

## Empacotar

Execute `npm run package` para gerar o VSIX. Para instalar, use **Extensions: Install from VSIX...** no VS Code.

## Limites atuais

O preview HTML não executa assemblies nem handlers C#; eventos comuns são editáveis e simulados como notificações visuais. Para executar a interface e handlers reais, use **Executar Form**; essa janela não pode ser incorporada ao Webview. ComboBox/ListBox leem e gravam itens literais; o DataGridView ainda usa uma grade ilustrativa, e imagens locais do PictureBox não são resolvidas pelo preview. Expressões C# de recursos, lambdas ou inicializadores complexos que Roslyn não consegue mapear são mantidas no arquivo e não são avaliadas visualmente. O projeto precisa compilar como WinForms para que o helper possa validar ou executar o resultado.