#!/usr/bin/env sh
# Downloads source 3D models (CC0, KayKit by Kay Lousberg) into art_src/. Not shipped with the game.
set -e
cd "$(dirname "$0")/../.."
mkdir -p art_src
R=https://raw.githubusercontent.com/KayKit-Game-Assets
curl -sSL -o art_src/Knight.glb "$R/KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb"
curl -sSL -o art_src/Skeleton_Warrior.glb "$R/KayKit-Character-Pack-Skeletons-1.0/main/addons/kaykit_character_pack_skeletons/Characters/gltf/Skeleton_Warrior.glb"
curl -sSL -o art_src/Skeleton_Minion.glb "$R/KayKit-Character-Pack-Skeletons-1.0/main/addons/kaykit_character_pack_skeletons/Characters/gltf/Skeleton_Minion.glb"
for f in Mage Rogue_Hooded; do curl -sSL -o "art_src/$f.glb" "$R/KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures/Characters/gltf/$f.glb"; done
echo "Models in art_src/"
