import React from "react";

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors anywhere in the tree and shows the message
 * instead of a blank white screen, so failures are diagnosable.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Dshh UI crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg-base p-8 text-center">
          <div className="text-lg font-semibold text-red-400">
            Something broke in the UI
          </div>
          <pre className="max-w-lg overflow-auto rounded-md border border-edge bg-bg-panel p-3 text-left text-xs text-[#dfe6ee]">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
