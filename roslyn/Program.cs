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
        ["RichTextBox"] = "RichTextBox", ["CheckBox"] = "CheckBox", ["RadioButton"] = "RadioButton",
        ["ComboBox"] = "ComboBox", ["ListBox"] = "ListBox", ["PictureBox"] = "PictureBox",
        ["GroupBox"] = "GroupBox", ["TabControl"] = "TabControl", ["DataGridView"] = "DataGridView",
        ["System.Windows.Forms.Panel"] = "Panel", ["System.Windows.Forms.Button"] = "Button",
        ["System.Windows.Forms.Label"] = "Label", ["System.Windows.Forms.TextBox"] = "TextBox",
        ["System.Windows.Forms.RichTextBox"] = "RichTextBox", ["System.Windows.Forms.CheckBox"] = "CheckBox",
        ["System.Windows.Forms.RadioButton"] = "RadioButton", ["System.Windows.Forms.ComboBox"] = "ComboBox",
        ["System.Windows.Forms.ListBox"] = "ListBox", ["System.Windows.Forms.PictureBox"] = "PictureBox",
        ["System.Windows.Forms.GroupBox"] = "GroupBox", ["System.Windows.Forms.TabControl"] = "TabControl",
        ["System.Windows.Forms.DataGridView"] = "DataGridView"
    };

    public static DesignerDocument Read(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        var type = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
            .FirstOrDefault(candidate => candidate.Members.OfType<MethodDeclarationSyntax>().Any(method => method.Identifier.ValueText == "InitializeComponent"))
            ?? throw new InvalidDataException("InitializeComponent() was not found.");
        var method = type.Members.OfType<MethodDeclarationSyntax>().First(item => item.Identifier.ValueText == "InitializeComponent");
        var diagnostics = root.SyntaxTree.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .Select(diagnostic => $"{diagnostic.Location.GetLineSpan().StartLinePosition.Line + 1}:{diagnostic.Location.GetLineSpan().StartLinePosition.Character + 1} {diagnostic.GetMessage()}")
            .ToList();
        var controls = new Dictionary<string, DesignerControl>(StringComparer.Ordinal);
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        var declaredControls = type.Members.OfType<FieldDeclarationSyntax>()
            .Where(field => field.Declaration.Type.ToString().Contains("System.Windows.Forms", StringComparison.Ordinal))
            .SelectMany(field => field.Declaration.Variables.Select(variable => variable.Identifier.ValueText))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var expression in MethodExpressions(method))
        {
            if (expression is not AssignmentExpressionSyntax assignment || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)) continue;
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

        var parsedItems = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var opaqueItems = new HashSet<string>(StringComparer.Ordinal);
        foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var controlName = ItemsControlName(invocation);
            if (controlName is null || !controls.TryGetValue(controlName, out var control) || control.type is not ("ComboBox" or "ListBox")) continue;
            if (!TryReadItems(invocation, out var values))
            {
                opaqueItems.Add(controlName);
                diagnostics.Add($"Os itens de '{controlName}' usam uma expressão que não pode ser editada; serão preservados.");
                continue;
            }
            if (!parsedItems.TryGetValue(controlName, out var items)) parsedItems[controlName] = items = new List<string>();
            items.AddRange(values);
        }
        foreach (var (name, items) in parsedItems.Where(pair => !opaqueItems.Contains(pair.Key)))
        {
            controls[name].properties["Items"] = JsonSerializer.Serialize(items);
            MarkManaged(controls[name], "Items");
        }

        foreach (var assignment in method.DescendantNodes().OfType<AssignmentExpressionSyntax>().Where(item => item.IsKind(SyntaxKind.AddAssignmentExpression)))
        {
            var (controlName, eventName) = ControlProperty(assignment.Left);
            if (controlName is null || eventName is null || !controls.TryGetValue(controlName, out var control)) continue;
            var handler = EventHandlerName(assignment.Right);
            if (string.IsNullOrWhiteSpace(handler)) diagnostics.Add($"O handler de {controlName}.{eventName} não pôde ser representado no Designer.");
            else control.events[eventName] = handler;
        }

        var form = NewControl("Form", type.Identifier.ValueText);
        form.parent = null;
        form.properties["Name"] = form.name;
        MarkManaged(form, "Name");
        form.children = controls.Values.Select(control =>
        {
            control.parent = parents.GetValueOrDefault(control.name);
            return control;
        }).Where(control => control.parent is null || !controls.ContainsKey(control.parent)).ToList();
        AttachChildren(form, controls, parents);

        foreach (var expression in MethodExpressions(method))
        {
            if (expression is not AssignmentExpressionSyntax assignment) continue;
            var (controlName, property) = ControlProperty(assignment.Left);
            if (controlName is not null && controls.TryGetValue(controlName, out var control)) ReadProperty(control, property ?? "", assignment.Right);
            else if (assignment.Left is MemberAccessExpressionSyntax formProperty && formProperty.Expression is ThisExpressionSyntax)
                ReadProperty(form, formProperty.Name.Identifier.ValueText, assignment.Right);
        }
            SetParentSizes(form);

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
        if (method.Body is null && method.ExpressionBody is not null)
        {
            var statement = SyntaxFactory.ExpressionStatement(method.ExpressionBody.Expression).WithLeadingTrivia(method.ExpressionBody.GetLeadingTrivia());
            var expandedMethod = method.WithBody(SyntaxFactory.Block(statement)).WithExpressionBody(null).WithSemicolonToken(default);
            type = type.ReplaceNode(method, expandedMethod);
            method = type.Members.OfType<MethodDeclarationSyntax>().First(item => item.Identifier.ValueText == "InitializeComponent");
        }
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
        var initializedNames = type.Members.OfType<FieldDeclarationSyntax>()
            .SelectMany(field => field.Declaration.Variables.Where(variable => variable.Initializer?.Value is ObjectCreationExpressionSyntax).Select(variable => variable.Identifier.ValueText))
            .Concat(method.Body.DescendantNodes().OfType<AssignmentExpressionSyntax>()
                .Select(assignment => DirectControlName(assignment.Left)).OfType<string>())
            .ToHashSet(StringComparer.Ordinal);
        var addedNames = method.Body.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .Select(AddedControlName).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var controlsToInitialize = controls.Where(control => !initializedNames.Contains(control.name)).ToList();
        var controlsToAdd = controls.Where(control => !addedNames.Contains(control.name)).ToList();
        var managedProperties = controls.ToDictionary(control => control.name, control =>
        {
            return control.managedProperties.ToHashSet(StringComparer.Ordinal);
        }, StringComparer.Ordinal);
        var managedEvents = controls.ToDictionary(control => control.name, control => control.events.Keys.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        var formManagedProperties = form.managedProperties.ToHashSet(StringComparer.Ordinal);
        var originalStatements = method.Body.Statements;
        var keptStatements = new List<StatementSyntax>();
        foreach (var statement in originalStatements)
        {
            if (IsManagedStatement(statement, removedNames, managedProperties, managedEvents) || IsManagedFormStatement(statement, formManagedProperties)) continue;
            keptStatements.Add(statement);
        }

        var generated = new List<StatementSyntax>();
        if (formManagedProperties.Contains("Size")) generated.Add(ParseStatement($"this.ClientSize = new System.Drawing.Size({form.size.width}, {form.size.height});"));
        if (formManagedProperties.Contains("Width")) generated.Add(ParseStatement($"this.Width = {form.size.width};"));
        if (formManagedProperties.Contains("Height")) generated.Add(ParseStatement($"this.Height = {form.size.height};"));
        if (formManagedProperties.Contains("Location")) generated.Add(ParseStatement($"this.Location = new System.Drawing.Point({form.location.x}, {form.location.y});"));
        foreach (var pair in form.properties)
        {
            if (!formManagedProperties.Contains(pair.Key)) continue;
            var expression = pair.Key switch
            {
                "Text" or "Name" => SyntaxFactory.Literal(ValueString(pair.Value)).ToString(),
                "Enabled" or "Visible" => bool.TryParse(ValueString(pair.Value), out var enabled) && enabled ? "true" : "false",
                "BackColor" when !string.IsNullOrWhiteSpace(ValueString(pair.Value)) => $"System.Drawing.ColorTranslator.FromHtml({SyntaxFactory.Literal(ValueString(pair.Value)).ToString()})",
                _ => null
            };
            if (expression is not null) generated.Add(ParseStatement($"this.{pair.Key} = {expression};"));
        }
        if (formManagedProperties.Contains("Font")) generated.Add(CreateFontStatement("this", form.properties));
        generated.AddRange(controlsToInitialize.Select(CreateControl));
        generated.AddRange(controls.SelectMany(CreateProperties));
        generated.AddRange(controls.SelectMany(CreateEvents));
        generated = generated.Select(statement => statement.WithLeadingTrivia(SyntaxFactory.EndOfLine(Environment.NewLine), SyntaxFactory.Whitespace("            "))).ToList();
        var insertionIndex = keptStatements.FindIndex(IsInsertionBoundary);
        if (insertionIndex < 0) insertionIndex = keptStatements.Count;
        var lastInitializerIndex = keptStatements.FindLastIndex(statement => IsControlInitialization(statement, currentNames));
        if (lastInitializerIndex >= insertionIndex) insertionIndex = lastInitializerIndex + 1;
        keptStatements.InsertRange(insertionIndex, generated);
        var additions = controlsToAdd.Select(CreateAdd)
            .Select(statement => statement.WithLeadingTrivia(SyntaxFactory.EndOfLine(Environment.NewLine), SyntaxFactory.Whitespace("            "))).ToList();
        if (additions.Count > 0)
        {
            var lastAddIndex = keptStatements.FindLastIndex(IsControlsAddStatement);
            var addIndex = lastAddIndex >= 0 ? lastAddIndex + 1 : keptStatements.FindIndex(IsLayoutEnd);
            if (addIndex < 0) addIndex = keptStatements.Count;
            keptStatements.InsertRange(addIndex, additions);
        }
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

    private static void SetParentSizes(DesignerControl parent)
    {
        foreach (var child in parent.children)
        {
            child.parentSize = new SizeModel { width = parent.size.width, height = parent.size.height };
            SetParentSizes(child);
        }
    }

    private static DesignerControl NewControl(string type, string name) => new()
    {
        type = type, name = name, properties = new Dictionary<string, object>(), managedProperties = new List<string>(), events = new Dictionary<string, string>(), children = new List<DesignerControl>(), parent = null,
        location = new PointModel(), size = type == "Form" ? new SizeModel { width = 800, height = 500 } : DefaultSize(type)
    };

    private static SizeModel DefaultSize(string type) => type switch
    {
        "Button" => new() { width = 120, height = 36 }, "Label" => new() { width = 120, height = 24 },
        "TextBox" => new() { width = 180, height = 28 }, "RichTextBox" => new() { width = 220, height = 120 },
        "CheckBox" or "RadioButton" => new() { width = 120, height = 24 }, "ComboBox" => new() { width = 160, height = 28 },
        "ListBox" or "PictureBox" => new() { width = 160, height = 120 }, "GroupBox" => new() { width = 240, height = 160 },
        "TabControl" => new() { width = 300, height = 200 }, "DataGridView" => new() { width = 360, height = 200 },
        _ => new() { width = 240, height = 160 }
    };

    private static void ReadProperty(DesignerControl control, string property, ExpressionSyntax value)
    {
        if (property is "Location" or "Size" or "ClientSize" && value is ObjectCreationExpressionSyntax creation && creation.ArgumentList?.Arguments.Count >= 2 &&
            TryInteger(creation.ArgumentList.Arguments[0].Expression, out var x) && TryInteger(creation.ArgumentList.Arguments[1].Expression, out var y))
        {
            if (property == "Location") control.location = new PointModel { x = x, y = y };
            else control.size = new SizeModel { width = x, height = y };
            MarkManaged(control, property == "Location" ? "Location" : "Size");
        }
        else if (property is "Width" or "Height" && TryInteger(value, out var dimension))
        {
            if (property == "Width") control.size.width = dimension; else control.size.height = dimension;
            MarkManaged(control, property);
        }
        else if (property is "Text" or "Name" or "ImageLocation" && value is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression))
        {
            control.properties[property] = literal.Token.ValueText;
            MarkManaged(control, property);
        }
        else if (property is "Enabled" or "Visible" or "Checked" && value is LiteralExpressionSyntax boolean)
        {
            control.properties[property] = boolean.Token.ValueText == "true";
            MarkManaged(control, property);
        }
        else if (property is "BackColor" or "ForeColor")
        {
            var color = ColorValue(value);
            if (!string.IsNullOrWhiteSpace(color)) { control.properties[property] = color; MarkManaged(control, property); }
        }
        else if (property == "TabIndex" && TryInteger(value, out var tabIndex) && tabIndex >= 0)
        {
            control.properties[property] = tabIndex;
            MarkManaged(control, property);
        }
        else if (property == "Anchor")
        {
            var anchor = EnumMembers(value, ["Top", "Bottom", "Left", "Right"]);
            if (anchor.Length > 0) { control.properties[property] = anchor.Replace("|", ", "); MarkManaged(control, property); }
        }
        else if (property == "Dock")
        {
            var dock = EnumMembers(value, ["None", "Top", "Bottom", "Left", "Right", "Fill"]);
            if (dock.Length > 0) { control.properties[property] = dock; MarkManaged(control, property); }
        }
        else if (property == "Font" && value is ObjectCreationExpressionSyntax font && font.ArgumentList?.Arguments.Count >= 2)
        {
            var arguments = font.ArgumentList.Arguments;
            if (arguments[0].Expression is not LiteralExpressionSyntax family || !family.IsKind(SyntaxKind.StringLiteralExpression)) return;
            var sizeText = arguments[1].Expression.ToString().TrimEnd('f', 'F', 'd', 'D');
            if (!double.TryParse(sizeText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var fontSize) || !double.IsFinite(fontSize) || fontSize <= 0) return;
            var styleNames = string.Join("|", arguments.Skip(2).Select(argument => EnumMembers(argument.Expression, ["Bold", "Italic", "Underline", "Strikeout"])));
            if (arguments.Count > 2 && styleNames.Length == 0) return;
            control.properties["FontFamily"] = family.Token.ValueText;
            control.properties["FontSize"] = fontSize;
            control.properties["FontBold"] = styleNames.Contains("Bold", StringComparison.Ordinal);
            control.properties["FontItalic"] = styleNames.Contains("Italic", StringComparison.Ordinal);
            control.properties["FontUnderline"] = styleNames.Contains("Underline", StringComparison.Ordinal);
            control.properties["FontStrikeout"] = styleNames.Contains("Strikeout", StringComparison.Ordinal);
            MarkManaged(control, "Font");
        }
    }

    private static void MarkManaged(DesignerControl control, string property)
    {
        if (!control.managedProperties.Contains(property, StringComparer.Ordinal)) control.managedProperties.Add(property);
    }

    private static string? EventHandlerName(ExpressionSyntax expression) => expression switch
    {
        ParenthesizedExpressionSyntax parenthesized => EventHandlerName(parenthesized.Expression),
        CastExpressionSyntax cast => EventHandlerName(cast.Expression),
        IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
        MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
        ObjectCreationExpressionSyntax creation when creation.ArgumentList?.Arguments.Count == 1 => EventHandlerName(creation.ArgumentList.Arguments[0].Expression),
        _ => null
    };

    private static string EnumMembers(ExpressionSyntax expression, string[] allowed) => string.Join("|", expression.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>()
        .Select(member => member.Name.Identifier.ValueText).Where(name => allowed.Contains(name, StringComparer.Ordinal)).Distinct());

    private static string ColorValue(ExpressionSyntax expression)
    {
        var text = expression.ToString();
        if (text.Contains("FromArgb", StringComparison.Ordinal) && expression is InvocationExpressionSyntax invocation)
        {
            var arguments = invocation.ArgumentList.Arguments.Select(item => item.Expression).ToArray();
            if (arguments.Length >= 3 && arguments.All(argument => TryInteger(argument, out _)))
            {
                var values = arguments.Select(argument => Integer(argument)).ToArray();
                return $"#{values[^3]:X2}{values[^2]:X2}{values[^1]:X2}";
            }
        }
        return text.EndsWith("White", StringComparison.Ordinal) ? "#FFFFFF" : text.EndsWith("Black", StringComparison.Ordinal) ? "#000000" :
            text.EndsWith("Red", StringComparison.Ordinal) ? "#FF0000" : text.EndsWith("Green", StringComparison.Ordinal) ? "#008000" :
            text.EndsWith("Blue", StringComparison.Ordinal) ? "#0000FF" : text.EndsWith("Yellow", StringComparison.Ordinal) ? "#FFFF00" :
            text.EndsWith("Transparent", StringComparison.Ordinal) ? "transparent" : "";
    }

    private static int Integer(ExpressionSyntax expression) => int.TryParse(expression.ToString(), out var value) ? value : 0;
    private static bool TryInteger(ExpressionSyntax expression, out int value)
    {
        if (expression is LiteralExpressionSyntax literal && literal.Token.Value is int literalValue) { value = literalValue; return true; }
        return int.TryParse(expression.ToString(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out value);
    }
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

    private static bool IsManagedStatement(StatementSyntax statement, HashSet<string> removedNames,
        Dictionary<string, HashSet<string>> managedProperties, Dictionary<string, HashSet<string>> managedEvents)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement) return false;
        if (expressionStatement.Expression is AssignmentExpressionSyntax assignment)
        {
            var direct = DirectControlName(assignment.Left);
            var (target, property) = ControlProperty(assignment.Left);
            if ((direct is not null && removedNames.Contains(direct)) || (target is not null && removedNames.Contains(target))) return true;
            if (target is not null && managedProperties.TryGetValue(target, out var properties) && property is not null &&
                (properties.Contains(property) || (property is "Width" or "Height" && properties.Contains("Size")))) return true;
            if (assignment.IsKind(SyntaxKind.AddAssignmentExpression) && target is not null && property is not null &&
                managedEvents.TryGetValue(target, out var events) && events.Contains(property)) return true;
        }
        if (expressionStatement.Expression is InvocationExpressionSyntax invocation)
        {
            var itemsControl = ItemsControlName(invocation);
            if (itemsControl is not null && managedProperties.TryGetValue(itemsControl, out var properties) && properties.Contains("Items")) return true;
            return removedNames.Contains(AddedControlName(invocation) ?? "");
        }
        return false;
    }

    private static string? ItemsControlName(InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax method || method.Name.Identifier.ValueText is not ("Add" or "AddRange" or "Clear") ||
            method.Expression is not MemberAccessExpressionSyntax items || items.Name.Identifier.ValueText != "Items") return null;
        return DirectControlName(items.Expression);
    }

    private static bool TryReadItems(InvocationExpressionSyntax invocation, out List<string> items)
    {
        items = new List<string>();
        if (invocation.Expression is not MemberAccessExpressionSyntax method) return false;
        if (method.Name.Identifier.ValueText == "Clear") return invocation.ArgumentList.Arguments.Count == 0;
        if (invocation.ArgumentList.Arguments.Count != 1) return false;
        var expression = invocation.ArgumentList.Arguments[0].Expression;
        if (method.Name.Identifier.ValueText == "Add")
        {
            if (expression is not LiteralExpressionSyntax literal || !literal.IsKind(SyntaxKind.StringLiteralExpression)) return false;
            items.Add(literal.Token.ValueText);
            return true;
        }

        SeparatedSyntaxList<ExpressionSyntax> expressions;
        if (expression is ArrayCreationExpressionSyntax array && array.Initializer is not null) expressions = array.Initializer.Expressions;
        else if (expression is ImplicitArrayCreationExpressionSyntax implicitArray) expressions = implicitArray.Initializer.Expressions;
        else return false;
        foreach (var item in expressions)
        {
            if (item is not LiteralExpressionSyntax itemLiteral || !itemLiteral.IsKind(SyntaxKind.StringLiteralExpression)) return false;
            items.Add(itemLiteral.Token.ValueText);
        }
        return true;
    }

    private static string? AddedControlName(InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax add || add.Name.Identifier.ValueText != "Add" ||
            add.Expression is not MemberAccessExpressionSyntax controls || controls.Name.Identifier.ValueText != "Controls" ||
            invocation.ArgumentList.Arguments.Count == 0) return null;
        return DirectControlName(invocation.ArgumentList.Arguments[0].Expression);
    }

    private static bool IsControlsAddStatement(StatementSyntax statement) =>
        statement is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax invocation } && AddedControlName(invocation) is not null;

    private static bool IsLayoutEnd(StatementSyntax statement) =>
        statement is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax member } } &&
        member.Name.Identifier.ValueText is "ResumeLayout" or "PerformLayout";

    private static bool IsInsertionBoundary(StatementSyntax statement) => IsControlsAddStatement(statement) || IsLayoutEnd(statement);

    private static bool IsControlInitialization(StatementSyntax statement, HashSet<string> names) =>
        statement is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment } &&
        names.Contains(DirectControlName(assignment.Left) ?? "");

    private static bool IsManagedFormStatement(StatementSyntax statement, HashSet<string> managedProperties)
    {
        if (statement is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment } ||
            assignment.Left is not MemberAccessExpressionSyntax access || access.Expression is not ThisExpressionSyntax) return false;
        var property = access.Name.Identifier.ValueText;
        return managedProperties.Contains(property) || (property == "ClientSize" && managedProperties.Contains("Size"));
    }

    private static StatementSyntax CreateControl(DesignerControl control) => ParseStatement($"this.{control.name} = new System.Windows.Forms.{control.type}();");

    private static IEnumerable<StatementSyntax> CreateProperties(DesignerControl control)
    {
        var managed = control.managedProperties.ToHashSet(StringComparer.Ordinal);
        if (managed.Contains("Location")) yield return ParseStatement($"this.{control.name}.Location = new System.Drawing.Point({control.location.x}, {control.location.y});");
        if (managed.Contains("Size")) yield return ParseStatement($"this.{control.name}.Size = new System.Drawing.Size({control.size.width}, {control.size.height});");
        else
        {
            if (managed.Contains("Width")) yield return ParseStatement($"this.{control.name}.Width = {control.size.width};");
            if (managed.Contains("Height")) yield return ParseStatement($"this.{control.name}.Height = {control.size.height};");
        }
        foreach (var pair in control.properties)
        {
            if (!managed.Contains(pair.Key)) continue;
            var expression = pair.Key switch
            {
                "Text" => SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(ValueString(pair.Value))).ToString(),
                "Name" => SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(ValueString(pair.Value))).ToString(),
                "ImageLocation" => SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(ValueString(pair.Value))).ToString(),
                "Enabled" or "Visible" or "Checked" => bool.TryParse(ValueString(pair.Value), out var enabled) && enabled ? "true" : "false",
                "BackColor" or "ForeColor" when !string.IsNullOrWhiteSpace(ValueString(pair.Value)) => $"System.Drawing.ColorTranslator.FromHtml({SyntaxFactory.Literal(ValueString(pair.Value)).ToString()})",
                "TabIndex" => int.TryParse(ValueString(pair.Value), out var tabIndex) && tabIndex >= 0 ? tabIndex.ToString(System.Globalization.CultureInfo.InvariantCulture) : throw new InvalidDataException("TabIndex deve ser um inteiro não negativo."),
                "Anchor" => EnumExpression("System.Windows.Forms.AnchorStyles", ValueString(pair.Value), ["Top", "Bottom", "Left", "Right"]),
                "Dock" => EnumExpression("System.Windows.Forms.DockStyle", ValueString(pair.Value), ["None", "Top", "Bottom", "Left", "Right", "Fill"]),
                _ => null
            };
            if (expression is not null) yield return ParseStatement($"this.{control.name}.{pair.Key} = {expression};");
        }
        if (managed.Contains("Items"))
        {
            var json = ValueString(control.properties["Items"]);
            var items = JsonSerializer.Deserialize<List<string>>(json) ?? new List<string>();
            yield return ParseStatement($"this.{control.name}.Items.Clear();");
            if (items.Count > 0)
            {
                var values = string.Join(", ", items.Select(item => SyntaxFactory.Literal(item).ToString()));
                yield return ParseStatement($"this.{control.name}.Items.AddRange(new object[] {{ {values} }});");
            }
        }
        if (managed.Contains("Font")) yield return CreateFontStatement($"this.{control.name}", control.properties);
    }

    private static IEnumerable<StatementSyntax> CreateEvents(DesignerControl control)
    {
        foreach (var pair in control.events)
        {
            if (string.IsNullOrWhiteSpace(pair.Value)) continue;
            if (!SyntaxFacts.IsValidIdentifier(pair.Key)) throw new InvalidDataException($"Nome de evento inválido: {pair.Key}");
            if (!SyntaxFacts.IsValidIdentifier(pair.Value)) throw new InvalidDataException($"Nome de handler inválido: {pair.Value}");
            yield return ParseStatement($"this.{control.name}.{pair.Key} += this.{pair.Value};");
        }
    }

    private static bool PropertyBool(DesignerControl control, string key) =>
        control.properties.TryGetValue(key, out var value) && bool.TryParse(ValueString(value), out var result) && result;

    private static StatementSyntax CreateFontStatement(string target, Dictionary<string, object> properties)
    {
        var style = new List<string>();
        if (PropertyBool(properties, "FontBold")) style.Add("Bold");
        if (PropertyBool(properties, "FontItalic")) style.Add("Italic");
        if (PropertyBool(properties, "FontUnderline")) style.Add("Underline");
        if (PropertyBool(properties, "FontStrikeout")) style.Add("Strikeout");
        var styleExpression = style.Count == 0 ? "System.Drawing.FontStyle.Regular" : string.Join(" | ", style.Select(name => $"System.Drawing.FontStyle.{name}"));
        var family = properties.TryGetValue("FontFamily", out var fontFamily) ? ValueString(fontFamily) : "Segoe UI";
        var fontSizeText = properties.TryGetValue("FontSize", out var size) ? ValueString(size) : "9";
        if (!double.TryParse(fontSizeText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var fontSize) || !double.IsFinite(fontSize) || fontSize <= 0)
            throw new InvalidDataException("FontSize deve ser um número positivo.");
        var numericSize = fontSize.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        return ParseStatement($"{target}.Font = new System.Drawing.Font({SyntaxFactory.Literal(family)}, {numericSize}F, {styleExpression});");
    }

    private static bool PropertyBool(Dictionary<string, object> properties, string key) =>
        properties.TryGetValue(key, out var value) && bool.TryParse(ValueString(value), out var result) && result;

    private static string? EnumExpression(string enumType, string value, string[] allowed)
    {
        var members = value.Split([',', '|'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(member => allowed.Contains(member, StringComparer.Ordinal)).Distinct(StringComparer.Ordinal).ToList();
        return members.Count == 0 ? null : string.Join(" | ", members.Select(member => $"{enumType}.{member}"));
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
    private static IEnumerable<ExpressionSyntax> MethodExpressions(MethodDeclarationSyntax method)
    {
        if (method.Body is not null) return method.Body.DescendantNodes().OfType<ExpressionStatementSyntax>().Select(statement => statement.Expression);
        if (method.ExpressionBody is not null) return [method.ExpressionBody.Expression];
        return [];
    }
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
    public List<string> managedProperties { get; set; } = new();
    public Dictionary<string, string> events { get; set; } = new();
    public List<DesignerControl> children { get; set; } = new();
    public string? parent { get; set; }
    public SizeModel? parentSize { get; set; }
    public PointModel location { get; set; } = new();
    public SizeModel size { get; set; } = new();
}

internal sealed class PointModel { public int x { get; set; } public int y { get; set; } }
internal sealed class SizeModel { public int width { get; set; } public int height { get; set; } }