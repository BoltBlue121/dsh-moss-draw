// KohakuMossTrainer's documented flow schedule: shifted float32 sigmas snapped
// to the 1000-step training grid, with ties going to the lower sigma.
const f32=Math.fround;
function linearGrid(count,last){
  if(count===1)return [1];
  const end=f32(last),step=f32(f32(end-1)/(count-1));
  return Array.from({length:count},(_,i)=>i<Math.floor(count/2)
    ?f32(1+f32(step*i)):f32(end-f32(step*(count-1-i))));
}
const train=linearGrid(1000,.001).reverse();
export function kohakuMossSigmas(steps,shift){
  if(!Number.isInteger(steps)||steps<1||steps>100||!Number.isFinite(shift)||shift<=0||shift>20)throw new RangeError('KohakuMoss requires 1..100 steps and a positive shift up to 20.');
  const result=[];
  for(const base of linearGrid(steps,shift/(999+shift))){
    const sigma=shift===1?base:f32(f32(f32(shift)*base)/f32(1+f32(f32(shift-1)*base)));
    let lo=0,hi=train.length-1;
    while(lo<hi){const mid=(lo+hi)>>>1;if(train[mid]<sigma)lo=mid+1;else hi=mid;}
    const below=train[Math.max(0,lo-1)],above=train[lo];
    const snapped=f32(Math.abs(sigma-below))<=f32(Math.abs(above-sigma))?below:above;
    if(result.at(-1)!==snapped)result.push(snapped);
  }
  return [...result,0];
}
