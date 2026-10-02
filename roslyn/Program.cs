using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: WinFormsDesigner.Roslyn <read|write> <Designer.cs>");
    return 2;
}

try
{
    var sourcePath = Path.GetFullPath(args[1]);
    var source = await File.ReadAllTextAsync(sourcePath);
    if (args[0] == "read")
    {
        Console.WriteLine(JsonSerializer.Serialize(Designer.Read(source), jsonOptions));
        return 0;
    }

    if (args[0] == "write")
    {
        using var reader = new StreamReader(Console.OpenStandardInput());
        var payload = await reader.ReadToEndAsync();
        var model = JsonSerializer.Deserialize<DesignerDocument>(payload, jsonOptions)
            ?? throw new InvalidDataException("The designer document is empty.");
        await File.WriteAllTextAsync(sourcePath, Designer.Write(source, model));
        return 0;
    }

    throw new ArgumentException($"Unknown operation: {args[0]}");
}
catch (Exception error)
{
    Console.Error.WriteLine(error);
    return 1;
}

internal static class Designer
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly Dictionary<string, string> SupportedTypes = new(StringComparer.Ordinal)
    {
        ["Panel"] = "Panel", ["Button"] = "Button", ["Label"] = "Label", ["TextBox"] = "TextBox",
        ["System.Windows.Forms.Panel"] = "Panel", ["System.Windows.Forms.Button"] = "Button",
        ["System.Windows.Forms.Label"] = "Label", ["System.Windows.Forms.TextBox"] = "TextBox"
    };

    public static DesignerDocument Read(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        var type = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
            .FirstOrDefault(candidate => candidate.Members.OfType<MethodDeclarationSyntax>().Any(method => method.Identifier.ValueText == "InitializeComponent"))
            ?? throw new InvalidDataException("InitializeComponent() was not found.");
        var method = type.Members.OfType<MethodDeclarationSyntax>().First(item => item.Identifier.ValueText == "InitializeComponent");
        var diagnostics = new List<string>();
        var controls = new Dictionary<string, DesignerControl>(StringComparer.Ordinal);
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        var declaredControls = type.Members.OfType<FieldDeclarationSyntax>()
            .Where(field => field.Declaration.Type.ToString().Contains("System.Windows.Forms", StringComparison.Ordinal))
            .SelectMany(field => field.Declaration.Variables.Select(variable => variable.Identifier.ValueText))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var statement in method.DescendantNodes().OfType<ExpressionStatementSyntax>())
        {
            if (statement.Expression is not AssignmentExpressionSyntax assignment || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)) continue;
            var name = DirectControlName(assignment.Left);
            if (name is null || !IsThisMember(assignment.Left) || !declaredControls.Contains(name)) continue;
            if (assignment.Right is ObjectCreationExpressionSyntax creation)
            {
                var typeName = creation.Type.ToString();
                var simple = typeName.Split('.').Last();
                if (SupportedTypes.TryGetValue(typeName, out var controlType) || SupportedTypes.TryGetValue(simple, out controlType))
                {
                    controls[name] = NewControl(controlType, name);
                    parents.TryAdd(name, null);
                }
                else diagnostics.Add($"Controle '{name}' ({simple}) não é editável no MVP e foi ignorado.");
                continue;
            }

            var (controlName, property) = ControlProperty(assignment.Left);
            if (controlName is null || property is null || !controls.TryGetValue(controlName, out var control)) continue;
            ReadProperty(control, property, assignment.Right);
        }

        foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is not MemberAccessExpressionSyntax add || add.Name.Identifier.ValueText != "Add" ||
                add.Expression is not MemberAccessExpressionSyntax controlsAccess || controlsAccess.Name.Identifier.ValueText != "Controls" ||
                invocation.ArgumentList.Arguments.Count == 0) continue;
            var childName = DirectControlName(invocation.ArgumentList.Arguments[0].Expression);
            if (childName is null || !controls.ContainsKey(childName)) continue;
            var parentName = DirectControlName(controlsAccess.Expression);
            parents[childName] = parentName == "Controls" ? "this" : parentName;
        }

        var form = NewControl("Form", type.Identifier.ValueText);
        form.parent = null;
        form.properties["Name"] = form.name;
        form.children = controls.Values.Select(control =>
        {
            control.parent = parents.GetValueOrDefault(control.name);
            return control;
        }).Where(control => control.parent is null || !controls.ContainsKey(control.parent)).ToList();
        AttachChildren(form, controls, parents);

        foreach (var statement in method.DescendantNodes().OfType<ExpressionStatementSyntax>())
        {
            if (statement.Expression is not AssignmentExpressionSyntax assignment) continue;
            var (controlName, property) = ControlProperty(assignment.Left);
            if (controlName is not null && controls.TryGetValue(controlName, out var control)) ReadProperty(control, property ?? "", assignment.Right);
            else if (assignment.Left is MemberAccessExpressionSyntax formProperty && formProperty.Expression is ThisExpressionSyntax)
                ReadProperty(form, formProperty.Name.Identifier.ValueText, assignment.Right);
        }

        return new DesignerDocument { formName = type.Identifier.ValueText, controls = new List<DesignerControl> { form }, diagnostics = diagnostics };
    }

    public static string Write(string source, DesignerDocument model)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetCompilationUnitRoot();
        var type = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
            .FirstOrDefault(candidate => candidate.Members.OfType<MethodDeclarationSyntax>().Any(method => method.Identifier.ValueText == "InitializeComponent"))
            ?? throw new InvalidDataException("InitializeComponent() was not found.");
        var method = type.Members.OfType<MethodDeclarationSyntax>().First(item => item.Identifier.ValueText == "InitializeComponent");
        if (method.Body is null) throw new InvalidDataException("InitializeComponent() must have a block body.");

        var form = model.controls.FirstOrDefault(control => control.type == "Form")
            ?? throw new InvalidDataException("The document must contain a Form root control.");
        var controls = Flatten(form.children).ToList();
        var existingFields = type.Members.OfType<FieldDeclarationSyntax>()
            .SelectMany(field => field.Declaration.Variables.Select(variable => new { Field = field, Name = variable.Identifier.ValueText }))
            .Where(item => LooksLikeSupportedControl(item.Field.Declaration.Type.ToString()))
            .ToList();
        var currentNames = controls.Select(control => control.name).ToHashSet(StringComparer.Ordinal);
        var removedNames = existingFields.Select(field => field.Name).Where(name => !currentNames.Contains(name)).ToHashSet(StringComparer.Ordinal);
        var managedNames = currentNames.Concat(existingFields.Select(field => field.Name)).ToHashSet(StringComparer.Ordinal);
        var originalStatements = method.Body.Statements;
        var firstManagedIndex = originalStatements.Count;
        var keptStatements = new List<StatementSyntax>();
        for (var index = 0; index < originalStatements.Count; index++)
        {
            var statement = originalStatements[index];
            if (IsManagedStatement(statement, managedNames, removedNames) || IsManagedFormStatement(statement)) { firstManagedIndex = Math.Min(firstManagedIndex, keptStatements.Count); continue; }
            keptStatements.Add(statement);
        }

        var generated = new List<StatementSyntax>();
        generated.Add(ParseStatement($"this.ClientSize = new System.Drawing.Size({form.size.width}, {form.size.height});"));
        generated.Add(ParseStatement($"this.Location = new System.Drawing.Point({form.location.x}, {form.location.y});"));
        foreach (var pair in form.properties)
        {
            var expression = pair.Key switch
            {
                "Text" or "Name" => SyntaxFactory.Literal(ValueString(pair.Value)).ToString(),
                "Enabled" or "Visible" => bool.TryParse(ValueString(pair.Value), out var enabled) && enabled ? "true" : "false",
                "BackColor" when !string.IsNullOrWhiteSpace(ValueString(pair.Value)) => $"System.Drawing.ColorTranslator.FromHtml({SyntaxFactory.Literal(ValueString(pair.Value)).ToString()})",
                _ => null
            };
            if (expression is not null) generated.Add(ParseStatement($"this.{pair.Key} = {expression};"));
        }
        generated.AddRange(controls.Select(CreateControl));
        generated.AddRange(controls.SelectMany(CreateProperties));
        generated.AddRange(controls.Select(CreateAdd));
        generated = generated.Select(statement => statement.WithLeadingTrivia(SyntaxFactory.EndOfLine(Environment.NewLine), SyntaxFactory.Whitespace("            "))).ToList();
        firstManagedIndex = Math.Min(firstManagedIndex, keptStatements.Count);
        keptStatements.InsertRange(firstManagedIndex, generated);
        var updatedMethod = method.WithBody(method.Body.WithStatements(SyntaxFactory.List(keptStatements)));
        type = type.ReplaceNode(method, updatedMethod);

        foreach (var group in existingFields.GroupBy(item => item.Field))
        {
            var fieldNames = group.Select(item => item.Name).ToHashSet(StringComparer.Ordinal);
            var field = type.Members.OfType<FieldDeclarationSyntax>()
                .FirstOrDefault(candidate => candidate.Declaration.Variables.Any(variable => fieldNames.Contains(variable.Identifier.ValueText)));
            if (field is null) continue;
            var variables = field.Declaration.Variables.Where(variable => currentNames.Contains(variable.Identifier.ValueText)).ToList();
            if (variables.Count == field.Declaration.Variables.Count) continue;
            if (variables.Count == 0) type = type.RemoveNode(field, SyntaxRemoveOptions.KeepExteriorTrivia) as ClassDeclarationSyntax ?? type;
            else type = type.ReplaceNode(field, field.WithDeclaration(field.Declaration.WithVariables(SyntaxFactory.SeparatedList(variables))));
        }

        var originalNames = existingFields.Select(item => item.Name).Where(currentNames.Contains).ToHashSet(StringComparer.Ordinal);
        var newFields = controls.Where(control => !originalNames.Contains(control.name)).Select(CreateField).Cast<MemberDeclarationSyntax>().ToList();
        if (newFields.Count > 0)
        {
            newFields = newFields.Select(field => field.WithLeadingTrivia(SyntaxFactory.EndOfLine(Environment.NewLine), SyntaxFactory.Whitespace("    ")).WithTrailingTrivia(SyntaxFactory.EndOfLine(Environment.NewLine))).ToList();
            type = type.WithMembers(type.Members.InsertRange(0, newFields));
        }
        var updatedRoot = root.ReplaceNode(root.DescendantNodes().OfType<ClassDeclarationSyntax>().First(candidate => candidate.Identifier.ValueText == type.Identifier.ValueText), type);
        var result = updatedRoot.ToFullString();
        return result.EndsWith(Environment.NewLine, StringComparison.Ordinal) ? result : result + Environment.NewLine;
    }

    private static void AttachChildren(DesignerControl parent, Dictionary<string, DesignerControl> controls, Dictionary<string, string?> parents)
    {
        foreach (var control in controls.Values.Where(item => parents.GetValueOrDefault(item.name) == parent.name))
        {
            parent.children.Add(control);
            AttachChildren(control, controls, parents);
        }
    }

    private static DesignerControl NewControl(string type, string name) => new()
    {
        type = type, name = name, properties = new Dictionary<string, object>(), children = new List<DesignerControl>(), parent = null,
        location = new PointModel(), size = type == "Form" ? new SizeModel { width = 800, height = 500 } : DefaultSize(type)
    };

    private static SizeModel DefaultSize(string type) => type switch
    {
        "Button" => new() { width = 120, height = 36 }, "Label" => new() { width = 120, height = 24 },
        "TextBox" => new() { width = 180, height = 28 }, _ => new() { width = 240, height = 160 }
    };

    private static void ReadProperty(DesignerControl control, string property, ExpressionSyntax value)
    {
        if (property is "Location" or "Size" or "ClientSize" && value is ObjectCreationExpressionSyntax creation && creation.ArgumentList?.Arguments.Count >= 2)
        {
            var x = Integer(creation.ArgumentList.Arguments[0].Expression); var y = Integer(creation.ArgumentList.Arguments[1].Expression);
            if (property == "Location") control.location = new PointModel { x = x, y = y };
            else control.size = new SizeModel { width = x, height = y };
        }
        else if (property is "Width" or "Height")
        {
            if (property == "Width") control.size.width = Integer(value); else control.size.height = Integer(value);
        }
        else if (property == "Text" && value is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression)) control.properties[property] = literal.Token.ValueText;
        else if (property == "Name" && value is LiteralExpressionSyntax nameLiteral && nameLiteral.IsKind(SyntaxKind.StringLiteralExpression)) control.properties[property] = nameLiteral.Token.ValueText;
        else if (property is "Enabled" or "Visible" && value is LiteralExpressionSyntax boolean) control.properties[property] = boolean.Token.ValueText == "true";
        else if (property == "BackColor") control.properties[property] = ColorValue(value);
    }

    private static string ColorValue(ExpressionSyntax expression)
    {
        var text = expression.ToString();
        if (text.Contains("FromArgb", StringComparison.Ordinal) && expression is InvocationExpressionSyntax invocation)
        {
            var values = invocation.ArgumentList.Arguments.Select(item => Integer(item.Expression)).ToArray();
            if (values.Length >= 3) return $"#{values[^3]:X2}{values[^2]:X2}{values[^1]:X2}";
        }
        return text.EndsWith("White", StringComparison.Ordinal) ? "#FFFFFF" : text.EndsWith("Black", StringComparison.Ordinal) ? "#000000" : "";
    }

    private static int Integer(ExpressionSyntax expression) => int.TryParse(expression.ToString(), out var value) ? value : 0;
    private static bool IsThisMember(ExpressionSyntax expression) => expression is MemberAccessExpressionSyntax access && access.Expression is ThisExpressionSyntax;

    private static string? DirectControlName(ExpressionSyntax expression)
    {
        if (expression is ParenthesizedExpressionSyntax parenthesized) return DirectControlName(parenthesized.Expression);
        if (expression is MemberAccessExpressionSyntax member && member.Expression is ThisExpressionSyntax) return member.Name.Identifier.ValueText;
        return expression is ThisExpressionSyntax ? "this" : null;
    }

    private static (string? Name, string? Property) ControlProperty(ExpressionSyntax expression)
    {
        if (expression is not MemberAccessExpressionSyntax propertyAccess) return (null, null);
        var control = DirectControlName(propertyAccess.Expression);
        return control is null || control == "this" ? (null, propertyAccess.Name.Identifier.ValueText) : (control, propertyAccess.Name.Identifier.ValueText);
    }

    private static bool IsManagedStatement(StatementSyntax statement, HashSet<string> names, HashSet<string> removedNames)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement) return false;
        if (expressionStatement.Expression is AssignmentExpressionSyntax assignment)
        {
            var direct = DirectControlName(assignment.Left);
            var (target, property) = ControlProperty(assignment.Left);
            if ((direct is not null && removedNames.Contains(direct)) || (target is not null && removedNames.Contains(target))) return true;
            if (direct is not null && names.Contains(direct)) return true;
            if (target is not null && names.Contains(target) && property is "Location" or "Size" or "Name" or "Text" or "Enabled" or "Visible" or "BackColor") return true;
        }
        if (expressionStatement.Expression is InvocationExpressionSyntax invocation && invocation.Expression is MemberAccessExpressionSyntax add && add.Name.Identifier.ValueText == "Add" && invocation.ArgumentList.Arguments.Count > 0)
            return names.Contains(DirectControlName(invocation.ArgumentList.Arguments[0].Expression) ?? "");
        return false;
    }

    private static bool IsManagedFormStatement(StatementSyntax statement) =>
        statement is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment } &&
        assignment.Left is MemberAccessExpressionSyntax access && access.Expression is ThisExpressionSyntax &&
        access.Name.Identifier.ValueText is "Name" or "Text" or "Location" or "ClientSize" or "Size" or "BackColor" or "Enabled" or "Visible";

    private static StatementSyntax CreateControl(DesignerControl control) => ParseStatement($"this.{control.name} = new System.Windows.Forms.{control.type}();");

    private static IEnumerable<StatementSyntax> CreateProperties(DesignerControl control)
    {
        yield return ParseStatement($"this.{control.name}.Location = new System.Drawing.Point({control.location.x}, {control.location.y});");
        yield return ParseStatement($"this.{control.name}.Size = new System.Drawing.Size({control.size.width}, {control.size.height});");
        foreach (var pair in control.properties)
        {
            var expression = pair.Key switch
            {
                "Text" => SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(ValueString(pair.Value))).ToString(),
                "Name" => SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(ValueString(pair.Value))).ToString(),
                "Enabled" or "Visible" => bool.TryParse(ValueString(pair.Value), out var enabled) && enabled ? "true" : "false",
                "BackColor" when !string.IsNullOrWhiteSpace(ValueString(pair.Value)) => $"System.Drawing.ColorTranslator.FromHtml({SyntaxFactory.Literal(ValueString(pair.Value)).ToString()})",
                _ => null
            };
            if (expression is not null) yield return ParseStatement($"this.{control.name}.{pair.Key} = {expression};");
        }
    }

    private static StatementSyntax CreateAdd(DesignerControl control)
    {
        var parent = string.IsNullOrWhiteSpace(control.parent) || control.parent == "this" ? "this" : $"this.{control.parent}";
        return ParseStatement($"{parent}.Controls.Add(this.{control.name});");
    }

    private static FieldDeclarationSyntax CreateField(DesignerControl control) =>
        (FieldDeclarationSyntax)SyntaxFactory.ParseMemberDeclaration($"private System.Windows.Forms.{control.type} {control.name};")!;

    private static string ValueString(object? value) => value is JsonElement element ? element.ToString() : Convert.ToString(value) ?? "";

    private static bool LooksLikeSupportedControl(string type) => SupportedTypes.Keys.Any(name => type.EndsWith(name, StringComparison.Ordinal));
    private static StatementSyntax ParseStatement(string statement) => SyntaxFactory.ParseStatement(statement);
    private static IEnumerable<DesignerControl> Flatten(IEnumerable<DesignerControl> controls)
    {
        foreach (var control in controls) { yield return control; foreach (var child in Flatten(control.children)) yield return child; }
    }
}

internal sealed class DesignerDocument
{
    public string formName { get; set; } = "Form1";
    public List<DesignerControl> controls { get; set; } = new();
    public List<string> diagnostics { get; set; } = new();
}

internal sealed class DesignerControl
{
    public string type { get; set; } = "Button";
    public string name { get; set; } = "button1";
    public Dictionary<string, object> properties { get; set; } = new();
    public List<DesignerControl> children { get; set; } = new();
    public string? parent { get; set; }
    public PointModel location { get; set; } = new();
    public SizeModel size { get; set; } = new();
}

internal sealed class PointModel { public int x { get; set; } public int y { get; set; } }
internal sealed class SizeModel { public int width { get; set; } public int height { get; set; } }