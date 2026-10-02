export type ControlType = "Form" | "Panel" | "Button" | "Label" | "TextBox" | "RichTextBox" | "CheckBox" | "RadioButton" | "ComboBox" | "ListBox" | "PictureBox" | "GroupBox" | "TabControl" | "DataGridView";

export interface DesignerControl {
  type: ControlType;
  name: string;
  properties: Record<string, string | number | boolean>;
  managedProperties: string[];
  events: Record<string, string>;
  children: DesignerControl[];
  parent: string | null;
  parentSize?: { width: number; height: number };
  location: { x: number; y: number };
  size: { width: number; height: number };
}

export interface DesignerDocument {
  formName: string;
  controls: DesignerControl[];
  diagnostics: string[];
  readOnly?: boolean;
}

export type DesignerMessage =
  | { type: "ready" }
  | { type: "save"; document: DesignerDocument; force?: boolean }
  | { type: "reload" }
  | { type: "run" }
  | { type: "stop" }
  | { type: "selectFile" }
  | { type: "error"; message: string };

export const defaultSizes: Record<ControlType, { width: number; height: number }> = {
  Form: { width: 800, height: 500 },
  Panel: { width: 240, height: 160 },
  Button: { width: 120, height: 36 },
  Label: { width: 120, height: 24 },
  TextBox: { width: 180, height: 28 },
  RichTextBox: { width: 220, height: 120 },
  CheckBox: { width: 120, height: 24 },
  RadioButton: { width: 120, height: 24 },
  ComboBox: { width: 160, height: 28 }, ListBox: { width: 160, height: 120 }, PictureBox: { width: 160, height: 120 },
  GroupBox: { width: 240, height: 160 }, TabControl: { width: 300, height: 200 }, DataGridView: { width: 360, height: 200 }
};