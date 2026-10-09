// lib/export.js — pure data-export helpers (no DOM, no writes).
// The block between the markers is mirrored verbatim (minus `export `) in
// index.html; tests/feat-export.test.mjs fails if the two copies drift.
// [feat:export-helpers]
const EXPORT_CSV_HEADER=["date","time","meal","calories","protein_g","carbs_g","fats_g","day_net_kcal","day_activity_kcal"];
function exportDays(data){
  const days=Array.isArray(data&&data.days)?data.days:[];
  const cur=data&&data.currentDay;
  return cur?[...days,{...cur,current:true}]:[...days];
}
export function buildJsonExport(data,now=new Date()){
  const d=data||{};
  return JSON.stringify({
    exportedAt:now.toISOString(),
    app:"NutriTrack",
    settings:d.settings||null,
    days:exportDays(d),
    weightLog:Array.isArray(d.weightLog)?d.weightLog:[],
  },null,2);
}
function csvCell(v){
  if(v===null||v===undefined||v==="")return"";
  if(typeof v==="number")return Number.isFinite(v)?String(v):"";
  let s=String(v);
  if(/^[=+\-@\t\r]/.test(s))s="'"+s;
  return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
export function buildCsv(data){
  const rows=[EXPORT_CSV_HEADER.map(csvCell).join(",")];
  exportDays(data).forEach(day=>{
    const meals=Array.isArray(day.meals)?day.meals:[];
    if(day.current&&!meals.length&&!day.activityCalories)return;
    const tail=[day.netCal,day.activityCalories];
    const lines=meals.length?meals:[{}];
    lines.forEach(m=>rows.push([day.date,m.time,m.name,m.calories,m.protein,m.carbs,m.fats,...tail].map(csvCell).join(",")));
  });
  return"﻿"+rows.join("\r\n")+"\r\n";
}
export function exportCounts(data){
  const days=exportDays(data);
  const meals=days.reduce((n,d)=>n+(Array.isArray(d.meals)?d.meals.length:0),0);
  const wl=data&&Array.isArray(data.weightLog)?data.weightLog.length:0;
  return{days:days.length,meals,weighIns:wl};
}
export function exportFilename(ext,now=new Date()){
  const p=n=>String(n).padStart(2,"0");
  return`nutritrack-${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}.${ext}`;
}
// [/feat:export-helpers]
