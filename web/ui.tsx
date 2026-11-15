import React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'
import { cn } from './lib'

export function Button({className,variant='default',...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'default'|'primary'|'danger'|'ghost'}){
  return <button className={cn('button',`button-${variant}`,className)} {...props}/>
}
export function Badge({children,tone='neutral'}:{children:React.ReactNode,tone?:'neutral'|'good'|'warn'|'bad'|'info'}){return <span className={`badge badge-${tone}`}>{children}</span>}
export function Card({className,children}:React.HTMLAttributes<HTMLDivElement>){return <div className={cn('card',className)}>{children}</div>}
export function Empty({title,body}:{title:string,body:string}){return <div className="empty"><strong>{title}</strong><p>{body}</p></div>}
export function Dialog({open,onOpenChange,title,description,children}:{open:boolean,onOpenChange:(v:boolean)=>void,title:string,description?:string,children:React.ReactNode}){
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className="dialog-content"><div className="dialog-head"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description&&<DialogPrimitive.Description>{description}</DialogPrimitive.Description>}</div><DialogPrimitive.Close asChild><Button variant="ghost" aria-label="Close"><X size={17}/></Button></DialogPrimitive.Close></div>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>
}
export function Tooltip({label,children}:{label:string,children:React.ReactElement}){return <TooltipPrimitive.Provider delayDuration={250}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="tooltip" sideOffset={6}>{label}<TooltipPrimitive.Arrow className="tooltip-arrow"/></TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>}
