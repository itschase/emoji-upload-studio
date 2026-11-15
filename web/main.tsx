import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { HostedApp } from './HostedApp'
import './styles.css'

const browserOnly=new URLSearchParams(location.search).get('mode')==='hosted'||!['127.0.0.1','localhost'].includes(location.hostname)
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{browserOnly?<HostedApp/>:<App/>}</React.StrictMode>,
)
