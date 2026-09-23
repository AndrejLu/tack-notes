import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './SettingsApp'
import '../styles/base.css'
import './settings.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
