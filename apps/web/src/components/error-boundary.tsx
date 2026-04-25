import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#f8f9fc] dark:bg-[#0e1745] text-[#0e1745] dark:text-white p-8">
          <div className="max-w-md text-center space-y-6">
            <div className="text-6xl">⚡</div>
            <h1 className="text-2xl font-bold font-heading tracking-tight">
              Algo salió mal
            </h1>
            <p className="text-sm opacity-60 leading-relaxed">
              La aplicación encontró un error inesperado. Intenta recargar la página.
            </p>
            {this.state.error && (
              <details className="text-left text-xs opacity-40 bg-black/5 dark:bg-white/5 rounded-xl p-4">
                <summary className="cursor-pointer font-medium mb-2">Detalles técnicos</summary>
                <pre className="whitespace-pre-wrap break-words">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={this.handleReload}
              className="px-6 py-3 bg-[#0047AB] text-white rounded-full font-medium text-sm hover:bg-[#003080] transition-colors shadow-md"
            >
              Recargar página
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
