// Agent 模块：连同它自己的样式表一起懒加载，避免未打开的模块也下载 CSS。
import '../../../agent/src/styles.css';
import { App } from '../../../agent/src/App';
export default App;
