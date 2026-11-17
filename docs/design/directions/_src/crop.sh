#!/bin/sh
# usage: crop.sh in.png out.png x y w h
sips -c "$6" "$5" --cropOffset "$4" "$3" "$1" --out "$2" >/dev/null
