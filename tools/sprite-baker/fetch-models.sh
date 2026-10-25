#!/usr/bin/env sh
# Downloads source 3D models (CC0, KayKit by Kay Lousberg) into art_src/. Not shipped with the game.
set -e
cd "$(dirname "$0")/../.."
mkdir -p art_src
A=https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures
S=https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0/main/addons/kaykit_character_pack_skeletons
for f in Knight Mage Rogue_Hooded; do curl -sSL -o "art_src/$f.glb" "$A/Characters/gltf/$f.glb"; done
for f in Skeleton_Warrior Skeleton_Minion Skeleton_Rogue Skeleton_Mage; do curl -sSL -o "art_src/$f.glb" "$S/Characters/gltf/$f.glb"; done
for f in Skeleton_Crossbow Skeleton_Staff Skeleton_Shield_Large_A Skeleton_Axe; do for e in gltf bin; do curl -sSL -o "art_src/$f.$e" "$S/Assets/gltf/$f.$e"; done; done
curl -sSL -o art_src/skeleton_texture.png "$S/Assets/gltf/skeleton_texture.png"
echo "Models in art_src/"
