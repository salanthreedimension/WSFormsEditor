#nullable enable

namespace WinFormsSample;

partial class Form1
{
    private System.ComponentModel.IContainer? components = null;
    private System.Windows.Forms.Button button1 = null!;
    private System.Windows.Forms.Label label1 = null!;
    private System.Windows.Forms.TextBox textBox1 = null!;
    private System.Windows.Forms.Panel panel1 = null!;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }

        base.Dispose(disposing);
    }

    private void InitializeComponent()
    {
        this.button1 = new System.Windows.Forms.Button();
        this.label1 = new System.Windows.Forms.Label();
        this.textBox1 = new System.Windows.Forms.TextBox();
        this.panel1 = new System.Windows.Forms.Panel();
        this.SuspendLayout();
        // 
        // button1
        // 
        this.button1.Location = new System.Drawing.Point(32, 112);
        this.button1.Name = "button1";
        this.button1.Size = new System.Drawing.Size(120, 36);
        this.button1.TabIndex = 0;
        this.button1.Text = "Clique";
        this.button1.UseVisualStyleBackColor = true;
        this.button1.Click += button1_Click;
        // 
        // label1
        // 
        this.label1.AutoSize = true;
        this.label1.Location = new System.Drawing.Point(32, 24);
        this.label1.Name = "label1";
        this.label1.Size = new System.Drawing.Size(120, 24);
        this.label1.TabIndex = 1;
        this.label1.Text = "Nome";
        // 
        // textBox1
        // 
        this.textBox1.Location = new System.Drawing.Point(32, 64);
        this.textBox1.Name = "textBox1";
        this.textBox1.Size = new System.Drawing.Size(180, 28);
        this.textBox1.TabIndex = 2;
        // 
        // panel1
        // 
        this.panel1.Location = new System.Drawing.Point(320, 24);
        this.panel1.Name = "panel1";
        this.panel1.Size = new System.Drawing.Size(240, 160);
        this.panel1.TabIndex = 3;
        // 
        // Form1
        // 
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(620, 300);
        this.Controls.Add(this.panel1);
        this.Controls.Add(this.textBox1);
        this.Controls.Add(this.label1);
        this.Controls.Add(this.button1);
        this.Name = "Form1";
        this.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
        this.Text = "WinForms Designer Sample";
        this.ResumeLayout(false);
        this.PerformLayout();
    }
}