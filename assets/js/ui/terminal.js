import { displayMessage } from "./messages.js";

function getTerminalOutput() {
  return document.getElementById("terminal-output");
}

export function terminal(command, message, type = "info") {
  const terminalOutput = getTerminalOutput();
  if (!terminalOutput) return;
  const line = document.createElement("div");
  line.className = `terminal-line terminal-line--${type}`;
  line.textContent = `${command ? `>${String(command).toLowerCase()} ` : ""}${displayMessage(message)}`;
  terminalOutput.appendChild(line);
  while (terminalOutput.childElementCount > 200)
    terminalOutput.firstElementChild.remove();
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

export function clearTerminal() {
  const terminalOutput = getTerminalOutput();
  if (terminalOutput) {
    terminalOutput.replaceChildren();
  }
}
