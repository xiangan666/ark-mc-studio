import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "./components";

export default class PageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Keep private runtime details out of public reports. */
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page page-recovery" role="alert">
        <TriangleAlert size={30} />
        <h1>此页面暂时无法显示</h1>
        <p>后台仍独立运行。可以重试当前页面，或使用侧栏进入其他功能。</p>
        <Button onClick={() => this.setState({ failed: false })}>
          <RefreshCw size={15} />
          重新打开此页
        </Button>
      </div>
    );
  }
}
