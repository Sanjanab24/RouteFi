import React from "react";
import ReactDOM from "react-dom/client";
import { Chart as ChartJS } from "chart.js";
import App from "./App.jsx";
import "./styles.css";

// Dark-theme defaults shared by every chart.
ChartJS.defaults.color = "#7d889b";
ChartJS.defaults.borderColor = "#222c3a";
ChartJS.defaults.font.family = 'Inter, "Segoe UI", system-ui, sans-serif';
ChartJS.defaults.font.size = 11.5;
ChartJS.defaults.plugins.tooltip.backgroundColor = "#1d2635";
ChartJS.defaults.plugins.tooltip.borderColor = "#2d394b";
ChartJS.defaults.plugins.tooltip.borderWidth = 1;
ChartJS.defaults.plugins.tooltip.titleColor = "#e6eaf0";
ChartJS.defaults.plugins.tooltip.bodyColor = "#b4bccb";
ChartJS.defaults.plugins.legend.labels.boxWidth = 10;
ChartJS.defaults.plugins.legend.labels.boxHeight = 10;
ChartJS.defaults.plugins.legend.labels.usePointStyle = true;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
