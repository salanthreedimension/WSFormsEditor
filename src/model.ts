export type ControlType = "Form" | "Panel" | "Button" | "Label" | "TextBox";

export interface DesignerControl {
  type: ControlType;
  name: string;
  properties: Record<string, string | number | boolean>;
  children: DesignerControl[];
  parent: string | null;
  location: { x: number; y: number };
  size: { width: number; height: number };
}

export interface DesignerDocument {
  formName: string;
  controls: DesignerControl[];
  diagnostics: string[];
}

export type DesignerMessage =
  | { type: "ready" }
  | { type: "save"; document: DesignerDocument }
  | { type: "selectFile" }
  | { type: "error"; message: string };

export const defaultSizes: Record<ControlType, { width: number; height: number }> = {
  Form: { width: 800, height: 500 },
  Panel: { width: 240, height: 160 },
  Button: { width: 120, height: 36 },
  Label: { width: 120, height: 24 },
  TextBox: { width: 180, height: 28 }
};