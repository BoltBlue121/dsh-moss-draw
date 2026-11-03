import {TypertRemoteService} from '@deepseek-ai/dsh-typert-protocol';
import {WORKBENCH_QUERY_REMOTE} from './workbench-query-contract.mjs';
import {readWorkbenchQuery} from './workbench-query.mjs';
export const name='moss-workbench-query';
export const inject=['typert','commands'];
export function apply(ctx){
 class WorkbenchQuery extends TypertRemoteService{
  constructor(context){super(context,'mossWorkbench');}
  read(agent,request,signal){return readWorkbenchQuery(this.ctx.commands,agent,request,signal);}
 }
 new WorkbenchQuery(ctx);
 ctx.typert.register({package:WORKBENCH_QUERY_REMOTE.package,face:'host',model:{services:[],events:[],objects:[]},schemas:[],invocations:WORKBENCH_QUERY_REMOTE.descriptors});
}
