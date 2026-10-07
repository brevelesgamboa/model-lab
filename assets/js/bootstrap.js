// The interface starts independently of optional machine-learning runtimes.
import("./app.js").catch((error) => {
  console.error("Latent Field could not start.", error);
  const status = document.getElementById("render-state");
  if (status) status.textContent = "APPLICATION LOAD FAILED";
});
