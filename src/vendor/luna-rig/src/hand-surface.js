import { fingerPoint, handFrame, handTurn } from "./hand-rig.js";
import { mix } from "./math.js";

/** One painted hand. Skin weights stay inside its connected finger topology. */
export function handSurfaceTargets(context, fingers) {
  const frame = handFrame(context), roll = 1 - .12 * Math.sin(Math.PI * handTurn(context));
  return [{root:frame.origin, tip:[frame.origin[0]+Math.cos(frame.angle)*frame.length,frame.origin[1]+Math.sin(frame.angle)*frame.length],width:frame.width*roll},
    ...fingers.map(name => ({root:fingerPoint(context,name,.5,0),tip:fingerPoint(context,name,.5,1),width:mix(context.manifest.handRig.fingers[name].width*.84,context.manifest.handRig.fingers[name].waveWidth,handTurn(context))*roll}))];
}

export function skinHandPoint(x, y, weights, sources, targets) {
  let px=0,py=0;
  for (let k=0;k<sources.length;k++) {
    const weight=weights[k];
    if (weight<.000001)continue;
    const source=sources[k],target=targets[k],sx=source.tip[0]-source.root[0],sy=source.tip[1]-source.root[1],length=Math.hypot(sx,sy);
    const dx=x-source.root[0],dy=y-source.root[1],along=(dx*sx+dy*sy)/(length*length),across=(-dx*sy+dy*sx)/(length*source.width);
    const tx=target.tip[0]-target.root[0],ty=target.tip[1]-target.root[1],normal=target.width/Math.hypot(tx,ty);
    px+=weight*(target.root[0]+along*tx-across*ty*normal);
    py+=weight*(target.root[1]+along*ty+across*tx*normal);
  }
  return [px,py];
}
